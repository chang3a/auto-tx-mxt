const fs = require('fs');
const { chromium } = require('playwright');

const GUILD_ID = '1027532323136229459';   // ID Server của bạn
const CHANNEL_ID = '1466241373165457480'; // ID kênh chat tài xỉu
const BET_AMOUNT = '10000000';               // Số tiền cược (10m)
const INTERVAL_TIME = 3 * 60 * 1000;        // 3 phút cho một chu kỳ ván mới
const MAX_SUCCESSFUL_BETS = 40;             // Mốc dừng tool (40 ván thành công)
const BATCH_SIZE = 10;                      // Số lượng token mỗi đợt
const STATE_FILE = 'state.json';            // File lưu trạng thái ván cược
const DEAD_TOKENS_FILE = 'dead_tokens.txt'; // File lưu danh sách token chết

function loadTokens() {
    if (!fs.existsSync('tokens.txt')) {
        console.error('[ERROR] Không tìm thấy file tokens.txt!');
        process.exit(1);
    }
    const rawTokens = fs.readFileSync('tokens.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    // Lọc bỏ những token đã bị ghi nhận là chết trước đó (nếu có)
    let deadTokens = [];
    if (fs.existsSync(DEAD_TOKENS_FILE)) {
        deadTokens = fs.readFileSync(DEAD_TOKENS_FILE, 'utf-8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    }

    return rawTokens.filter(token => !deadTokens.includes(token));
}

function saveDeadToken(token) {
    try {
        fs.appendFileSync(DEAD_TOKENS_FILE, token + '\n', 'utf-8');
    } catch (e) {
        console.error('[ERROR] Không ghi được file dead_tokens.txt:', e.message);
    }
}

function loadState() {
    const todayStr = new Date().toDateString();
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            if (data.date === todayStr) {
                console.log(`[STATE] Khôi phục trạng thái cũ: Đã cược thành công ${data.totalSuccessfulBets}/${MAX_SUCCESSFUL_BETS} ván.`);
                return data.totalSuccessfulBets;
            }
        }
    } catch (e) {
        console.error('[ERROR] Không đọc được file state.json, tạo mới bộ đếm.');
    }
    return 0;
}

function saveState(bets) {
    try {
        const data = {
            totalSuccessfulBets: bets,
            date: new Date().toDateString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[ERROR] Không ghi được file state.json:', e.message);
    }
}

let totalSuccessfulBets = loadState();
let lastResetDate = new Date().getDate();

function checkDailyReset() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentDate = now.getDate();

    if (hours === 0 && minutes >= 1 && currentDate !== lastResetDate) {
        totalSuccessfulBets = 0;
        lastResetDate = currentDate;
        saveState(totalSuccessfulBets);
        console.log(`\n[RESET] Đã qua 00:01 ngày mới. Đã reset bộ đếm ván cược về 0/40!`);
    }
}

async function main() {
    const allTokens = loadTokens();
    if (allTokens.length === 0) {
        console.error('[ERROR] Không có token nào khả dụng trong tokens.txt!');
        process.exit(1);
    }

    console.log(`[VPS START] Tổng số token hợp lệ: ${allTokens.length}. Chuẩn bị chạy theo từng đợt ${BATCH_SIZE} token...`);

    // Chia danh sách token thành các đợt nhỏ
    const tokenBatches = [];
    for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
        tokenBatches.push(allTokens.slice(i, i + BATCH_SIZE));
    }

    // Hàm thực hiện cho mỗi chu kỳ ván mới
    const playNewRound = async () => {
        checkDailyReset();
        if (totalSuccessfulBets >= MAX_SUCCESSFUL_BETS) {
            console.log(`[INFO] Đã đạt giới hạn ${MAX_SUCCESSFUL_BETS} ván trong ngày. Tạm ngưng chờ qua ngày mới.`);
            return;
        }

        const now = new Date().toLocaleTimeString('vi-VN');
        console.log(`\n========================================`);
        console.log(`[VÁN MỚI] Bắt đầu chu kỳ lúc ${now} (Tổng ván: ${totalSuccessfulBets}/${MAX_SUCCESSFUL_BETS})`);
        console.log(`========================================`);

        // Khởi động trình duyệt chung cho vòng lặp ván này
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

        let isMainCommandSent = false;

        // Vòng lặp chạy từng đợt token
        for (let bIndex = 0; bIndex < tokenBatches.length; bIndex++) {
            if (totalSuccessfulBets >= MAX_SUCCESSFUL_BETS) break;

            // Nếu không phải đợt đầu tiên, nghỉ ngơi ngẫu nhiên 5 - 9 giây trước khi sang đợt tiếp theo
            if (bIndex > 0) {
                const restTime = Math.floor(Math.random() * 4000) + 5000; 
                console.log(`[BATCH] Nghỉ ngơi ${restTime / 1000} giây trước khi chuyển sang đợt ${bIndex + 1}...`);
                await new Promise(r => setTimeout(r, restTime));
            }

            const currentBatchTokens = tokenBatches[bIndex];
            console.log(`\n[BATCH ${bIndex + 1}] Bắt đầu mở và xử lý đợt này (${currentBatchTokens.length} tài khoản)...`);

            const batchPages = [];

            // 1. Mở các tài khoản trong đợt hiện tại
            for (let i = 0; i < currentBatchTokens.length; i++) {
                const token = currentBatchTokens[i];
                const globalIndex = bIndex * BATCH_SIZE + i + 1;

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
                    
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(1500);

                    // Kiểm tra token chết
                    if (page.url().includes('/login')) {
                        console.warn(`[WARNING] Acc ${globalIndex} Token chết/văng phiên! Lưu vào dead_tokens.txt`);
                        saveDeadToken(token);
                        await context.close();
                        continue;
                    }

                    batchPages.push({ page, context, token, index: globalIndex });
                } catch (err) {
                    console.error(`[ERROR] Acc ${globalIndex} lỗi kết nối:`, err.message);
                    saveDeadToken(token);
                }
            }

            if (batchPages.length === 0) {
                console.log(`[BATCH ${bIndex + 1}] Không có tài khoản sống nào trong đợt này, bỏ qua.`);
                continue;
            }

            // 2. Nếu chưa gửi lệnh .tx, dùng tài khoản đầu tiên của đợt đầu tiên làm Nick chính để gửi .tx
            if (!isMainCommandSent && batchPages.length > 0) {
                try {
                    const mainAcc = batchPages[0];
                    console.log(`[NICK CHÍNH - Acc ${mainAcc.index}] Gửi lệnh .tx mở ván mới...`);
                    await mainAcc.page.mouse.click(600, 780);
                    await mainAcc.page.waitForTimeout(500);
                    await mainAcc.page.keyboard.type('.tx');
                    await mainAcc.page.keyboard.press('Enter');
                    isMainCommandSent = true;

                    console.log(`[INFO] Đã gửi lệnh .tx! Chờ 5 giây để game hiển thị nút cược...`);
                    await new Promise(r => setTimeout(r, 5000));
                } catch (err) {
                    console.error('[ERROR] Nick chính lỗi khi gửi .tx:', err.message);
                }
            }

            // 3. Tiến hành quét và đặt cược cho các tài khoản trong đợt này
            for (const acc of batchPages) {
                if (totalSuccessfulBets >= MAX_SUCCESSFUL_BETS) break;

                try {
                    const selectBox = acc.page.locator('div:has-text("Chọn cửa và đặt cược")').last();
                    if (await selectBox.isVisible()) {
                        await acc.page.waitForTimeout(300);
                        await selectBox.click();
                        await acc.page.waitForTimeout(800);

                        const clickedTai = await acc.page.evaluate(() => {
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
                            const modalInput = acc.page.locator('div[role="dialog"] input[type="text"]');
                            try {
                                await modalInput.waitFor({ state: 'visible', timeout: 3000 });
                                if (await modalInput.isVisible()) {
                                    await acc.page.waitForTimeout(400);
                                    await modalInput.click();
                                    await modalInput.fill(BET_AMOUNT);
                                    
                                    await acc.page.keyboard.press('Enter');
                                    await acc.page.waitForTimeout(400);

                                    const submitButton = acc.page.locator('div[role="dialog"] button:has-text("Gửi"), div[role="dialog"] button:has-text("Submit")').last();
                                    if (await submitButton.isVisible()) {
                                        await submitButton.click();
                                        totalSuccessfulBets++;
                                        saveState(totalSuccessfulBets);
                                        console.log(`[VPS - Acc ${acc.index}] Cược thành công ${BET_AMOUNT} cửa Tài! ==> Tổng: ${totalSuccessfulBets}/${MAX_SUCCESSFUL_BETS}`);
                                    }
                                }
                            } catch (modalErr) {
                                await acc.page.keyboard.press('Escape');
                            }
                        }
                    }
                } catch (e) {
                    try {
                        await acc.page.keyboard.press('Escape');
                    } catch (err) {}
                }
                await acc.page.waitForTimeout(400 + Math.random() * 300);
            }

            // 4. ĐOẠN QUAN TRỌNG: Đóng toàn bộ các tab và context của đợt này ngay sau khi chạy xong để giải phóng RAM
            console.log(`[BATCH ${bIndex + 1}] Đã hoàn thành đợt này. Đang đóng toàn bộ tài khoản của đợt để giải phóng RAM...`);
            for (const acc of batchPages) {
                try {
                    await acc.context.close();
                } catch (err) {}
            }
        }

        // Đóng trình duyệt chung của ván này
        try {
            await browser.close();
        } catch (err) {}

        console.log(`[INFO] Hoàn tất chu kỳ ván hiện tại. Trình duyệt đã được đóng hoàn toàn.`);
    };

    // Chạy ván đầu tiên sau 5 giây khởi động và lặp định kỳ mỗi 3 phút
    setTimeout(playNewRound, 5000);
    setInterval(playNewRound, INTERVAL_TIME);
}

main();