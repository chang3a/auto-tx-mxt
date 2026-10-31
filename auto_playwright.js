const fs = require('fs');
const { chromium } = require('playwright');

const GUILD_ID = '1027532323136229459';   // ID Server của bạn
const CHANNEL_ID = '1466241373165457480'; // ID kênh chat tài xỉu
const BET_AMOUNT = '10000000';               // Số tiền cược (10m)
const INTERVAL_TIME = 2.5 * 60 * 1000;      // 2 phút 30 giây mỗi lượt
const MAX_PER_TOKEN = 40;                   // Mỗi tài khoản hoàn thành 40 ván
const BATCH_SIZE = 5;                       // Xử lý song song từng nhóm 5 tài khoản
const MAX_CONSECUTIVE_ERRORS = 3;           // Quá 3 ván lỗi liên tiếp sẽ tự động bỏ qua/loại bỏ token
const STATE_FILE = 'state.json';            // File lưu trạng thái từng token
const DEAD_TOKENS_FILE = 'dead_tokens.txt'; // File lưu danh sách token chết

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
            console.log(`[CLEAN] Đã tự động loại bỏ token lỗi ra khỏi tokens.txt`);
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

async function main() {
    const allTokens = loadTokens();
    if (allTokens.length === 0) {
        console.error('[ERROR] Không có token nào khả dụng trong tokens.txt!');
        process.exit(1);
    }

    console.log(`[VPS START] Tổng số token: ${allTokens.length}. Mỗi token hoàn thành ${MAX_PER_TOKEN} ván (Chu kỳ: 2 phút 30 giây).`);

    const startProcess = async () => {
        checkDailyReset();

        const currentTokens = loadTokens();

        for (let i = 0; i < currentTokens.length; i += BATCH_SIZE) {
            const batchTokens = currentTokens.slice(i, i + BATCH_SIZE);
            const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
            const startIndex = i + 1;

            console.log(`\n========================================`);
            console.log(`[NHÓM ${batchIndex}] Khởi động và giữ nguyên phiên cho các Acc từ ${startIndex} đến ${Math.min(startIndex + BATCH_SIZE - 1, currentTokens.length)}`);
            console.log(`========================================`);

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

            let sessions = [];
            for (let j = 0; j < batchTokens.length; j++) {
                const token = batchTokens[j];
                const globalIndex = startIndex + j;
                if (!tokenStates[token]) tokenStates[token] = 0;

                if (tokenErrors[token] && tokenErrors[token] >= MAX_CONSECUTIVE_ERRORS) continue;

                try {
                    const context = await browser.newContext({
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

                    if (page.url().includes('/login') || !(await page.url().includes(GUILD_ID))) {
                        console.warn(`[WARNING] Acc ${globalIndex} Token chết hoặc chưa vào server!`);
                        saveDeadToken(token);
                        tokenErrors[token] = MAX_CONSECUTIVE_ERRORS;
                        await context.close();
                        continue;
                    }

                    await page.waitForSelector('div[role="textbox"]', { timeout: 25000 });
                    sessions.push({ context, page, token, globalIndex, isMain: (globalIndex === 1) });
                    console.log(`[LOGGED IN] Acc ${globalIndex} đã sẵn sàng trong phiên.`);
                } catch (err) {
                    console.log(`[WARNING] Acc ${globalIndex} không thể kết nối ban đầu.`);
                    saveDeadToken(token); // ĐÃ THÊM: Tự động đưa vào dead_tokens và xóa khỏi tokens.txt ngay lập tức
                    tokenErrors[token] = MAX_CONSECUTIVE_ERRORS;
                }
            }

            if (sessions.length === 0) {
                await browser.close();
                continue;
            }

            let isBatchComplete = false;
            while (!isBatchComplete) {
                isBatchComplete = batchTokens.every(token => {
                    const completed = (tokenStates[token] || 0) >= MAX_PER_TOKEN;
                    const isDiscarded = (tokenErrors[token] || 0) >= MAX_CONSECUTIVE_ERRORS;
                    return completed || isDiscarded;
                });

                if (isBatchComplete) break;

                const now = new Date().toLocaleTimeString('vi-VN');
                console.log(`\n--- [NHÓM ${batchIndex}] Thực hiện ván mới lúc ${now} ---`);

                const mainSession = sessions.find(s => s.isMain);
                if (mainSession) {
                    try {
                        const chatBox = mainSession.page.locator('div[role="textbox"]').first();
                        await chatBox.click();
                        await mainSession.page.waitForTimeout(300);
                        await mainSession.page.keyboard.type('.tx');
                        await mainSession.page.keyboard.press('Enter');
                        console.log(`[INFO] Nick chính (Acc ${mainSession.globalIndex}) đã gửi lệnh .tx! Đang chờ nút cược...`);
                        await mainSession.page.waitForTimeout(5000);
                    } catch (e) {
                        console.error(`[ERROR] Nick chính không thể gửi lệnh .tx ở ván này`);
                    }
                } else {
                    await new Promise(r => setTimeout(r, 3000));
                }

                const betPromises = sessions.map(async (session) => {
                    try {
                        const { page, token, globalIndex } = session;
                        if ((tokenStates[token] || 0) >= MAX_PER_TOKEN) return;

                        await page.waitForTimeout(Math.random() * 800 + 200);

                        const selectBox = page.locator('div:has-text("Chọn cửa và đặt cược")').last();
                        if (await selectBox.isVisible()) {
                            await selectBox.click();
                            await page.waitForTimeout(500);

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
                                            tokenErrors[token] = 0;
                                            console.log(`[CƯỢC THÀNH CÔNG] Acc ${globalIndex} đã đặt ${BET_AMOUNT} cửa Tài! (Tổng: ${tokenStates[token]}/${MAX_PER_TOKEN} ván)`);
                                        }
                                    }
                                } catch (modalErr) {
                                    await page.keyboard.press('Escape');
                                }
                            }
                        }
                    } catch (err) {
                        tokenErrors[session.token] = (tokenErrors[session.token] || 0) + 1;
                        if (tokenErrors[session.token] >= MAX_CONSECUTIVE_ERRORS) {
                            console.warn(`⚠️ [BỎ QUA] Acc ${session.globalIndex} lỗi quá số lần cho phép.`);
                            saveDeadToken(session.token);
                        }
                    }
                });

                await Promise.all(betPromises);

                isBatchComplete = batchTokens.every(token => {
                    const completed = (tokenStates[token] || 0) >= MAX_PER_TOKEN;
                    const isDiscarded = (tokenErrors[token] || 0) >= MAX_CONSECUTIVE_ERRORS;
                    return completed || isDiscarded;
                });

                if (!isBatchComplete) {
                    console.log(`[INFO] Nhóm ${batchIndex} đang chờ 2 phút 30 giây cho chu kỳ ván tiếp theo...`);
                    await new Promise(r => setTimeout(r, INTERVAL_TIME));
                }
            }

            try {
                await browser.close();
            } catch (e) {}

            console.log(`\n🎉 [HOÀN TẤT] Nhóm ${batchIndex} đã xong toàn bộ 40 ván! Chuyển sang nhóm tiếp theo...\n`);
        }

        console.log(`[INFO] Hoàn tất toàn bộ các nhóm tài khoản trong ngày!`);
    };

    startProcess();
}

main();
