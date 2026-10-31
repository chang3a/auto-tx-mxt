const fs = require('fs');
const { chromium } = require('playwright');

const GUILD_ID = '1027532323136229459';   // ID Server của bạn
const CHANNEL_ID = '1466241373165457480'; // ID kênh chat tài xỉu
const BET_AMOUNT = '10000000';               // Số tiền cược (10m)
const INTERVAL_TIME = 3 * 60 * 1000;        // 3 phút cho một chu kỳ ván mới
const MAX_PER_TOKEN = 40;                   // Mỗi tài khoản phải hoàn thành đủ 40 ván
const BATCH_SIZE = 5;                       // Xử lý song song từng nhóm 5 tài khoản
const MAX_CONSECUTIVE_ERRORS = 3;           // Quá 3 ván lỗi liên tiếp sẽ tự động bỏ qua/loại bỏ token
const STATE_FILE = 'state.json';            // File lưu trạng thái từng token
const DEAD_TOKENS_FILE = 'dead_tokens.txt'; // File lưu danh sách token chết

// Theo dõi số lần lỗi liên tiếp của từng token trong phiên chạy
const tokenErrors = {};

function loadTokens() {
    if (!fs.existsSync('tokens.txt')) {
        console.error('[ERROR] Không tìm thấy file tokens.txt!');
        process.exit(1);
    }
    
    const rawTokens = fs.readFileSync('tokens.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const uniqueTokens = [...new Set(rawTokens)];

    let deadTokens = [];
    if (fs.existsSync(DEAD_TOKENS_FILE)) {
        deadTokens = fs.readFileSync(DEAD_TOKENS_FILE, 'utf-8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    }

    return uniqueTokens.filter(token => !deadTokens.includes(token));
}

function saveDeadToken(token) {
    try {
        let deadTokens = [];
        if (fs.existsSync(DEAD_TOKENS_FILE)) {
            deadTokens = fs.readFileSync(DEAD_TOKENS_FILE, 'utf-8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
        }

        if (!deadTokens.includes(token)) {
            fs.appendFileSync(DEAD_TOKENS_FILE, token + '\n', 'utf-8');
        }

        if (fs.existsSync('tokens.txt')) {
            const currentTokens = fs.readFileSync('tokens.txt', 'utf-8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            const remainingTokens = currentTokens.filter(t => t !== token);
            fs.writeFileSync('tokens.txt', remainingTokens.join('\n') + (remainingTokens.length > 0 ? '\n' : ''), 'utf-8');
            console.log(`[CLEAN] Đã tự động loại bỏ token lỗi quá 3 ván khỏi tokens.txt`);
        }
    } catch (e) {}
}

function loadAllStates() {
    const todayStr = new Date().toDateString();
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            if (data.date === todayStr && data.tokens) {
                return data.tokens;
            }
        }
    } catch (e) {}
    return {};
}

function saveAllStates(tokenStates) {
    try {
        const data = {
            date: new Date().toDateString(),
            tokens: tokenStates
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

let tokenStates = loadAllStates();
let lastResetDate = new Date().getDate();

function checkDailyReset() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentDate = now.getDate();

    if (hours === 0 && minutes >= 1 && currentDate !== lastResetDate) {
        tokenStates = {};
        lastResetDate = currentDate;
        saveAllStates(tokenStates);
        console.log(`\n[RESET] Đã qua 00:01 ngày mới. Đã reset bộ đếm ván cược về 0!`);
    }
}

async function runSingleRoundForBatch(batchTokens, startIndex) {
    const browser = await chromium.launch({
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    let readySessions = [];

    const initPromises = batchTokens.map(async (token, j) => {
        const globalIndex = startIndex + j;
        if ((tokenStates[token] || 0) >= MAX_PER_TOKEN) return;
        if (!tokenStates[token]) tokenStates[token] = 0;

        // Nếu token này đã lỗi quá số lần cho phép thì bỏ qua luôn
        if (tokenErrors[token] && tokenErrors[token] >= MAX_CONSECUTIVE_ERRORS) {
            return;
        }

        let context = null;
        try {
            context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
            
            await context.addInitScript((t) => {
                localStorage.setItem('token', `"${t}"`);
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            }, token);

            const page = await context.newPage();
            const targetUrl = `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`;
            
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

            // Kiểm tra token chết / văng login
            if (page.url().includes('/login')) {
                console.warn(`[WARNING] Acc ${globalIndex} Token chết/văng phiên!`);
                saveDeadToken(token);
                tokenErrors[token] = MAX_CONSECUTIVE_ERRORS; // Đánh dấu loại bỏ
                await context.close();
                return;
            }

            await page.waitForTimeout(3000);
            // Kiểm tra chưa vào server
            if (!page.url().includes(GUILD_ID)) {
                console.warn(`[WARNING] Acc ${globalIndex} chưa vào server!`);
                saveDeadToken(token);
                tokenErrors[token] = MAX_CONSECUTIVE_ERRORS; // Đánh dấu loại bỏ
                await context.close();
                return;
            }

            let chatReady = false;
            try {
                await page.waitForSelector('div[role="textbox"]', { timeout: 25000 });
                chatReady = true;
            } catch (e) {
                try {
                    await page.reload({ waitUntil: 'load', timeout: 25000 });
                    await page.waitForSelector('div[role="textbox"]', { timeout: 20000 });
                    chatReady = true;
                } catch (reloadErr) {
                    console.log(`[WARNING] Acc ${globalIndex} mạng chậm/mất kết nối.`);
                }
            }

            if (chatReady) {
                readySessions.push({ context, page, token, globalIndex, isMain: (globalIndex === 1) });
            } else {
                // Tăng bộ đếm lỗi liên tiếp cho token này
                tokenErrors[token] = (tokenErrors[token] || 0) + 1;
                console.log(`[LỖI] Acc ${globalIndex} lỗi kết nối lần ${tokenErrors[token]}/${MAX_CONSECUTIVE_ERRORS}`);
                
                if (tokenErrors[token] >= MAX_CONSECUTIVE_ERRORS) {
                    console.warn(`⚠️ [BỎ QUA] Acc ${globalIndex} lỗi quá ${MAX_CONSECUTIVE_ERRORS} ván liên tiếp. Hệ thống tự động loại bỏ token này!`);
                    saveDeadToken(token);
                }
                await context.close();
            }
        } catch (err) {
            tokenErrors[token] = (tokenErrors[token] || 0) + 1;
            if (tokenErrors[token] >= MAX_CONSECUTIVE_ERRORS) {
                saveDeadToken(token);
            }
            if (context) {
                try { await context.close(); } catch (e) {}
            }
        }
    });

    await Promise.all(initPromises);

    if (readySessions.length === 0) {
        try { await browser.close(); } catch (e) {}
        return;
    }

    const mainSession = readySessions.find(s => s.isMain);
    if (mainSession) {
        try {
            const chatBox = mainSession.page.locator('div[role="textbox"]').first();
            await chatBox.click();
            await mainSession.page.waitForTimeout(300);
            await mainSession.page.keyboard.type('.tx');
            await mainSession.page.keyboard.press('Enter');
            console.log(`[INFO] Nick chính (Acc ${mainSession.globalIndex}) đã gửi lệnh .tx! Đang chờ nút cược...`);
            await mainSession.page.waitForTimeout(6000);
        } catch (e) {
            console.error(`[ERROR] Nick chính không thể gửi lệnh .tx`);
        }
    } else {
        await new Promise(r => setTimeout(r, 3000));
    }

    const betPromises = readySessions.map(async (session) => {
        try {
            const { page, token, globalIndex } = session;
            await page.waitForTimeout(Math.random() * 1000 + 300);

            const selectBox = page.locator('div:has-text("Chọn cửa và đặt cược")').last();
            if (await selectBox.isVisible()) {
                await selectBox.click();
                await page.waitForTimeout(600);

                const clickedTai = await page.evaluate(() => {
                    const allDivs = Array.from(document.querySelectorAll('div'));
                    for (const d of allDivs) {
                        if (d.innerText && d.innerText.trim() === 'Tài' && d.clientHeight > 0 && d.clientWidth > 0) {
                            const rect = d.getBoundingClientRect();
                            if (rect.y > 300) {
                                d.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (clickedTai) {
                    const modalInput = page.locator('div[role="dialog"] input[type="text"]');
                    try {
                        await modalInput.waitFor({ state: 'visible', timeout: 3000 });
                        if (await modalInput.isVisible()) {
                            await modalInput.click();
                            await modalInput.fill(BET_AMOUNT);
                            await modalInput.press('Enter');
                            await page.waitForTimeout(300);

                            const submitButton = page.locator('div[role="dialog"] button:has-text("Gửi"), div[role="dialog"] button:has-text("Submit")').last();
                            if (await submitButton.isVisible()) {
                                await submitButton.click();
                                tokenStates[token]++;
                                saveAllStates(tokenStates);
                                
                                // Nếu cược thành công, reset lại số đếm lỗi của token này về 0
                                tokenErrors[token] = 0;
                                
                                console.log(`[CƯỢC THÀNH CÔNG] Acc ${globalIndex} đã đặt ${BET_AMOUNT} cửa Tài! (Tổng: ${tokenStates[token]}/${MAX_PER_TOKEN} ván)`);
                            }
                        }
                    } catch (modalErr) {
                        await page.keyboard.press('Escape');
                    }
                }
            }
        } catch (err) {} 
        finally {
            if (session.context) {
                try { await session.context.close(); } catch (e) {}
            }
        }
    });

    await Promise.all(betPromises);
    try { await browser.close(); } catch (e) {}
}

async function main() {
    const allTokens = loadTokens();
    if (allTokens.length === 0) {
        console.error('[ERROR] Không có token nào khả dụng trong tokens.txt!');
        process.exit(1);
    }

    console.log(`[VPS START] Tổng số token: ${allTokens.length}. Mỗi token cần hoàn thành ${MAX_PER_TOKEN} ván (Tự động loại bỏ nếu lỗi quá ${MAX_CONSECUTIVE_ERRORS} ván liên tiếp).`);

    const startProcess = async () => {
        checkDailyReset();

        // Tải lại danh sách token mới nhất (phòng trường hợp có token bị xóa tự động)
        const currentTokens = loadTokens();

        for (let i = 0; i < currentTokens.length; i += BATCH_SIZE) {
            const batchTokens = currentTokens.slice(i, i + BATCH_SIZE);
            const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
            const startIndex = i + 1;

            // Xác định điều kiện hoàn thành của nhóm: 
            // Các token trong nhóm hoặc đã đủ 40 ván, hoặc đã bị lỗi quá 3 lần và bị loại bỏ
            let isBatchComplete = batchTokens.every(token => {
                const completed = (tokenStates[token] || 0) >= MAX_PER_TOKEN;
                const isDiscarded = (tokenErrors[token] || 0) >= MAX_CONSECUTIVE_ERRORS;
                return completed || isDiscarded;
            });

            while (!isBatchComplete) {
                const now = new Date().toLocaleTimeString('vi-VN');
                console.log(`\n========================================`);
                console.log(`[NHÓM ${batchIndex}] Bắt đầu lúc ${now} cho các Acc hợp lệ trong khoảng từ ${startIndex} đến ${Math.min(startIndex + BATCH_SIZE - 1, currentTokens.length)}`);
                console.log(`========================================`);

                await runSingleRoundForBatch(batchTokens, startIndex);

                // Kiểm tra lại trạng thái sau ván đấu
                isBatchComplete = batchTokens.every(token => {
                    const completed = (tokenStates[token] || 0) >= MAX_PER_TOKEN;
                    const isDiscarded = (tokenErrors[token] || 0) >= MAX_CONSECUTIVE_ERRORS;
                    return completed || isDiscarded;
                });

                if (!isBatchComplete) {
                    console.log(`[INFO] Nhóm ${batchIndex} chưa hoàn tất (có acc chưa đủ 40 ván hoặc đang thử lại). Đợi 3 phút...`);
                    await new Promise(r => setTimeout(r, INTERVAL_TIME));
                }
            }

            console.log(`\n🎉 [HOÀN TẤT] Nhóm ${batchIndex} đã xử lý xong các tài khoản hợp lệ! Chuyển sang nhóm tiếp theo...\n`);
        }

        console.log(`[INFO] Hoàn tất toàn bộ các nhóm tài khoản trong ngày!`);
    };

    startProcess();
}

main();
