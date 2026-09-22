// BankFlow v7.0 - Premium Dual-Format Statement Dashboard (Credit Card & Current Account)
const pdfjsLib = window['pdfjs-dist/build/pdf'];

const DEFAULT_JUNK_KEYWORDS = [
    "Standard Bank", "BANK STATEMENT", "TAX INVOICE", "BUSINESS CURRENT ACCOUNT",
    "Statement Frequency", "VAT Reg. No.", "Statement from", "Account Number", 
    "Month-end Balance", "DAILY BALANCE ANALYSIS", "Account Summary", 
    "Details of Agreement", "Summary of Transactions", "VAT Summary",
    "Fee Structure", "Overdraft Rate*", "BizDirect", "PO BOX",
    "Registered credit provider", "Ombudsman", "Details Service",
    "Debits Credits", "Date Balance", "unresolved disputes", 
    "Authorised financial services", "Page ", "Statement No",
    "Statement / Invoice No", "Fee Debits", "Fees include VAT",
    "*Overdraft facilities", "Annual Rate of Interest", "Monthly Repayment amount",
    "Frequency of instalment", "Balance available at date of statement", "Arranged Limit",
    "Net Payment Received", "Interest Charged", "Total charge amount",
    "This document constitutes a Credit Note", "www.standardbank.co.za", "VAT"
];

const DEFAULT_CATEGORIES = [
    "Bank Fees: FEE:", "Bank Fees: SERVICE FEE", "Bank Fees: CASH DEPOSIT FEE",
    "Interest: INTEREST", "Tax: VAT", "Salary: SALARY", "ATM Withdrawal: ATM",
    "Electronic Transfer: EFT", "Card Purchase: PURCHASE"
];

let appState = {
    batchData: [], 
    junkKeywords: [...DEFAULT_JUNK_KEYWORDS],
    categories: [...DEFAULT_CATEGORIES],
    filters: { keyword: true, regex: true, strict: false, sanity: true },
    splitMethod: "center",
    splitX: 297.5,
    masterTransactions: [],
    masterExclusions: [],
    lastPdfPassword: '',
    pendingPasswordRequest: null,
    resumeLoaderText: ''
};

function refreshIcons() {
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeId(str) {
    return "file-" + str.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function parsePeriodDate(str) {
    if (!str) return null;
    let parts = str.trim().split(/\s+/);
    if (parts.length >= 3) {
        let day = parseInt(parts[0], 10);
        let monthStr = parts[1].toLowerCase().substring(0, 3);
        let month = MONTHS[monthStr] || 1;
        let year = parseInt(parts[2], 10);
        return { day, month, year };
    }
    return null;
}

function parseCreditCardPeriodDate(str) {
    if (!str) return null;
    let parts = str.trim().split(/\s+/);
    if (parts.length >= 3) {
        let day = parseInt(parts[0], 10);
        let monthStr = parts[1].toLowerCase().substring(0, 3);
        let month = MONTHS[monthStr] || 1;
        let yearStr = parts[2];
        let year = parseInt(yearStr, 10);
        if (yearStr.length === 2) {
            year = 2000 + year;
        }
        return { day, month, year };
    }
    return null;
}

function formatShortDate(d) {
    if (!d) return "";
    const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.day.toString().padStart(2, '0')} ${shortMonths[d.month - 1]} ${d.year}`;
}

function getTransactionYear(txnDateStr, startPeriod, endPeriod, guessedYear) {
    if (!txnDateStr) return guessedYear;
    let parts = txnDateStr.split(/\s+/);
    if (parts.length < 2) return guessedYear;
    let month = parseInt(parts[0], 10);
    
    if (startPeriod && endPeriod) {
        if (startPeriod.year === endPeriod.year) {
            return startPeriod.year;
        }
        if (month >= startPeriod.month) {
            return startPeriod.year;
        } else {
            return endPeriod.year;
        }
    }
    return guessedYear;
}

const elements = {
    dropZone: () => document.getElementById('dropZone'),
    fileInput: () => document.getElementById('fileInput'),
    resultsArea: () => document.getElementById('resultsArea'),
    txnTable: () => document.getElementById('txnTable').querySelector('tbody'),
    rawOutput: () => document.getElementById('rawOutput'),
    exclusionTable: () => document.getElementById('exclusionTable').querySelector('tbody'),
    dashboard: () => document.getElementById('dashboard'),
    txnCount: () => document.getElementById('txnCount'),
    fileCount: () => document.getElementById('fileCount'),
    batchStatus: () => document.getElementById('batchStatus'),
    loader: () => document.getElementById('loader'),
    loaderText: () => document.getElementById('loaderText'),
    configModal: () => document.getElementById('configModal'),
    categoryInput: () => document.getElementById('categoryInput'),
    junkInput: () => document.getElementById('junkInput'),
    saveConfig: () => document.getElementById('saveConfig'),
    closeConfig: () => document.getElementById('closeConfig'),
    toggleConfig: () => document.getElementById('toggleConfig'),
    addFiles: () => document.getElementById('addFiles'),
    toggles: () => document.querySelectorAll('.toggle-item'),
    jumpToTop: () => document.getElementById('jumpToTop'),
    tabs: () => document.querySelectorAll('.tab-btn'),
    textModal: () => document.getElementById('textModal'),
    textModalTitle: () => document.getElementById('textModalTitle'),
    textModalArea: () => document.getElementById('textModalArea'),
    copyTextModal: () => document.getElementById('copyTextModal'),
    closeTextModal: () => document.getElementById('closeTextModal'),
    downloadMethod: () => document.getElementById('downloadMethod'),
    splitMethodSelect: () => document.getElementById('splitMethodSelect'),
    splitXInput: () => document.getElementById('splitXInput'),
    customXContainer: () => document.getElementById('customXContainer'),
    passwordModal: () => document.getElementById('passwordModal'),
    passwordForm: () => document.getElementById('passwordForm'),
    passwordMessage: () => document.getElementById('passwordMessage'),
    passwordInput: () => document.getElementById('passwordInput'),
    cancelPassword: () => document.getElementById('cancelPassword')
};

// Patterns for Current Account
const valPattern = /(-?[\d,.]+[.,]\d{2}-?)\s+(\d{2}\s+\d{2})\s+(-?[\d,.]+[.,]\d{2}-?)/;

// Patterns for Credit Card
const ccStandardRegex = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{2})\s+(.+?)\s+(-?[\d,.]+[.,]\d{2})$/;

function classifyStatement(lines, rawPages) {
    for (let line of lines) {
        const uText = line.toUpperCase();
        if (uText.includes("CARD DIVISION") || 
            uText.includes("GOLD CARD") || 
            uText.includes("PLATINUM CARD") || 
            uText.includes("CREDIT LIMIT") || 
            uText.includes("AVAILABLE MONEY TO SPEND") || 
            uText.includes("TRANSACTION DETAILS ACCOUNT")) {
            return 'credit';
        }
    }
    for (let line of lines) {
        const uText = line.toUpperCase();
        if (uText.includes("DATE DESCRIPTION AMOUNT (R) BALANCE (R)") ||
            (uText.includes("DATE DESCRIPTION") && uText.includes("AMOUNT (R)") && uText.includes("BALANCE (R)"))) {
            return 'weekly';
        }
    }
    if (rawPages) {
        for (let page of rawPages) {
            const pageText = page.items.map(it => it.str).join(' ').toUpperCase();
            if (pageText.includes("DATE DESCRIPTION AMOUNT (R) BALANCE (R)") ||
                (pageText.includes("DATE DESCRIPTION") && pageText.includes("AMOUNT (R)") && pageText.includes("BALANCE (R)"))) {
                return 'weekly';
            }
        }
    }
    return 'current';
}

function parseWeeklyStatement(pagesItems) {
    const monthMap = {
        'january': '01', 'february': '02', 'march': '03', 'april': '04',
        'may': '05', 'june': '06', 'july': '07', 'august': '08',
        'september': '09', 'october': '10', 'november': '11', 'december': '12'
    };

    const reconstructedLines = [];

    for (let pageIdx = 0; pageIdx < pagesItems.length; pageIdx++) {
        const items = pagesItems[pageIdx];
        const sortedItems = [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

        const linesByY = [];
        let curLine = null;
        for (let it of sortedItems) {
            const y = it.transform[5];
            if (!curLine || Math.abs(curLine.y - y) > 2) {
                curLine = { y, items: [it], text: it.str };
                linesByY.push(curLine);
            } else {
                curLine.items.push(it);
                curLine.text += (it.transform[4] - (curLine.lastX || 0) > 2 ? " " : "") + it.str;
            }
            curLine.lastX = it.transform[4] + (it.width || 0);
        }

        if (pageIdx === 0) {
            for (let line of linesByY) {
                if (line.text.toUpperCase().includes("BALANCE BROUGHT FORWARD")) {
                    reconstructedLines.push(line.text.trim());
                    break;
                }
            }
        }

        const rowAnchors = [];
        for (let line of linesByY) {
            if (line.y > 750 || line.y < 60) continue;
            const rightItems = line.items.filter(it => it.transform[4] > 400 && it.str.trim().length > 0);
            if (!rightItems.length) continue;
            const combinedRight = rightItems.map(it => it.str).join(' ').trim();
            const m = combinedRight.match(/(-?\s*[\d,.]+[.,]\d{2}-?)\s+(-?\s*[\d,.]+[.,]\d{2}-?)/);
            if (m) {
                rowAnchors.push({
                    y: line.y,
                    amountRaw: m[1].replace(/\s+/g, ''),
                    balanceRaw: m[2].replace(/\s+/g, '')
                });
            }
        }

        for (let anchor of rowAnchors) {
            const rowItems = sortedItems.filter(it => it.transform[5] >= anchor.y - 18 && it.transform[5] <= anchor.y + 18);

            let day = '';
            let month = '';
            const topDescItems = [];
            const bottomDescItems = [];

            for (let it of rowItems) {
                const text = it.str.trim();
                if (!text) continue;
                const x = it.transform[4];
                const y = it.transform[5];

                if (x < 100) {
                    if (/^\d{1,2}$/.test(text)) {
                        day = text.padStart(2, '0');
                    } else if (monthMap[text.toLowerCase()]) {
                        month = monthMap[text.toLowerCase()];
                    }
                } else if (x >= 100 && x <= 400) {
                    if (y > anchor.y) {
                        topDescItems.push(text);
                    } else {
                        bottomDescItems.push(text);
                    }
                }
            }

            const topText = topDescItems.join(' ').replace(/\s+/g, ' ').trim();
            const bottomText = bottomDescItems.join(' ').replace(/\s+/g, ' ').trim();

            let fullDesc = '';
            if (bottomText && topText) {
                fullDesc = `${bottomText} | ${topText}`;
            } else {
                fullDesc = bottomText || topText;
            }

            const dateStr = (day && month) ? `${day} ${month}` : (day ? `${day} 01` : '01 01');
            reconstructedLines.push(`${fullDesc} ${anchor.amountRaw} ${dateStr} ${anchor.balanceRaw}`);
        }

        if (pageIdx < pagesItems.length - 1) {
            reconstructedLines.push("--- PAGE BREAK ---");
        }
    }

    return reconstructedLines;
}

function init() {
    const savedJunk = localStorage.getItem('bankflow_v7_junk') || localStorage.getItem('bankflow_v618_junk') || localStorage.getItem('bankflow_v617_junk') || localStorage.getItem('bankflow_v616_junk') || localStorage.getItem('bankflow_v615_junk');
    const savedCats = localStorage.getItem('bankflow_v7_cats') || localStorage.getItem('bankflow_v618_cats') || localStorage.getItem('bankflow_v617_cats') || localStorage.getItem('bankflow_v616_cats') || localStorage.getItem('bankflow_v615_cats');
    if (savedJunk) appState.junkKeywords = savedJunk.split('\n').filter(l => l.trim());
    if (savedCats) appState.categories = savedCats.split('\n').filter(l => l.trim());
    elements.junkInput().value = appState.junkKeywords.join('\n');
    elements.categoryInput().value = appState.categories.join('\n');
    
    // Load splitting configurations
    const savedSplitMethod = localStorage.getItem('bankflow_v7_split_method') || 'center';
    const savedSplitX = localStorage.getItem('bankflow_v7_split_x') || '297.5';
    appState.splitMethod = savedSplitMethod;
    appState.splitX = parseFloat(savedSplitX);
    
    elements.splitMethodSelect().value = appState.splitMethod;
    elements.splitXInput().value = appState.splitX;
    elements.customXContainer().style.display = appState.splitMethod === 'custom' ? 'block' : 'none';
    
    setupEvents();
    refreshIcons();
}

function setupEvents() {
    elements.dropZone().onclick = () => elements.fileInput().click();
    elements.addFiles().onclick = () => elements.fileInput().click();
    document.getElementById('closeLoader').onclick = () => hideLoader();
    
    elements.fileInput().onchange = e => e.target.files.length && processFiles(Array.from(e.target.files));
    elements.dropZone().ondragover = e => { e.preventDefault(); elements.dropZone().classList.add('active'); };
    elements.dropZone().ondragleave = () => elements.dropZone().classList.remove('active');
    elements.dropZone().ondrop = e => { e.preventDefault(); processFiles(Array.from(e.dataTransfer.files)); };

    elements.toggles().forEach(t => {
        const input = t.querySelector('input');
        input.addEventListener('change', () => {
            appState.filters[t.dataset.filter] = input.checked;
            t.classList.toggle('active', input.checked);
            applyBatchFilters();
        });
    });

    elements.tabs().forEach(btn => {
        btn.onclick = () => {
            elements.tabs().forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        };
    });

    elements.toggleConfig().onclick = () => {
        const modal = elements.configModal();
        modal.classList.remove('hidden');
        setTimeout(() => modal.classList.add('visible'), 10);
    };

    elements.closeConfig().onclick = () => {
        const modal = elements.configModal();
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 300);
    };

    elements.splitMethodSelect().onchange = e => {
        elements.customXContainer().style.display = e.target.value === 'custom' ? 'block' : 'none';
    };

    elements.saveConfig().onclick = () => {
        appState.junkKeywords = elements.junkInput().value.split('\n').map(l => l.trim()).filter(l => l);
        appState.categories = elements.categoryInput().value.split('\n').map(l => l.trim()).filter(l => l);
        
        // Save splitting configurations
        appState.splitMethod = elements.splitMethodSelect().value;
        appState.splitX = parseFloat(elements.splitXInput().value) || 297.5;
        
        localStorage.setItem('bankflow_v7_junk', elements.junkInput().value);
        localStorage.setItem('bankflow_v7_cats', elements.categoryInput().value);
        localStorage.setItem('bankflow_v7_split_method', appState.splitMethod);
        localStorage.setItem('bankflow_v7_split_x', appState.splitX.toString());
        
        elements.closeConfig().onclick();
        applyBatchFilters();
    };

    elements.closeTextModal().onclick = () => {
        const modal = elements.textModal();
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 300);
    };

    elements.copyTextModal().onclick = () => {
        const text = elements.textModalArea().value;
        navigator.clipboard.writeText(text).then(() => {
            alert("Data copied to clipboard successfully!");
        }).catch(err => {
            console.error("Clipboard Error:", err);
            alert("Clipboard access blocked. Please select all text in the box and copy manually (Ctrl+C).");
        });
    };

    window.onscroll = () => elements.jumpToTop().classList.toggle('visible', window.scrollY > 300);
    elements.jumpToTop().onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    
    document.getElementById('exportMasterCsv').onclick = () => exportAll('csv');
    document.getElementById('exportMasterXlsx').onclick = () => exportAll('xlsx');

    if (elements.cancelPassword()) elements.cancelPassword().onclick = () => settlePasswordPrompt(null);
    if (elements.passwordForm()) {
        elements.passwordForm().onsubmit = e => {
            e.preventDefault();
            const password = elements.passwordInput().value;
            if (!password.trim()) {
                elements.passwordInput().focus();
                return;
            }
            settlePasswordPrompt(password);
        };
    }
}

function requestPdfPassword(filename, incorrectPassword = false) {
    if (appState.pendingPasswordRequest) return Promise.reject(new Error('Another password prompt is already open.'));
    const modal = elements.passwordModal();
    if (!modal) return Promise.reject(new Error(`Password required for ${filename}, but password prompt is missing.`));
    const loaderIsVisible = !elements.loader().classList.contains('hidden');
    appState.resumeLoaderText = loaderIsVisible ? elements.loaderText().textContent : '';
    if (loaderIsVisible) hideLoader();
    elements.passwordMessage().textContent = incorrectPassword
        ? `The password for ${filename} was incorrect. Enter the correct password to continue.`
        : `${filename} is password-protected. Enter the PDF password to continue parsing.`;
    elements.passwordInput().value = incorrectPassword ? '' : appState.lastPdfPassword;
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('visible');
        elements.passwordInput().focus();
        elements.passwordInput().select();
    }, 10);
    return new Promise(resolve => {
        appState.pendingPasswordRequest = resolve;
    });
}

function settlePasswordPrompt(password) {
    const resolve = appState.pendingPasswordRequest;
    if (!resolve) return;
    appState.pendingPasswordRequest = null;
    const modal = elements.passwordModal();
    modal.classList.remove('visible');
    setTimeout(() => modal.classList.add('hidden'), 300);
    if (password === null) elements.passwordInput().value = '';
    if (appState.resumeLoaderText) {
        showLoader(appState.resumeLoaderText);
        appState.resumeLoaderText = '';
    }
    resolve(password);
}

async function processFiles(files) {
    showLoader(`Queueing ${files.length} Files...`);
    try {
        for (let file of files) {
            if (!file.name.toLowerCase().endsWith('.pdf')) continue;
            if (appState.batchData.some(d => d.filename === file.name && d.size === file.size)) continue;
            showLoader(`Parsing ${file.name}...`);
            const parsed = await parsePdf(file);
            appState.batchData.push({ 
                filename: file.name, size: file.size, 
                rawPages: parsed.rawPages, // Raw in-memory page store for instant split-method updating!
                lines: [], 
                metadataLines: [],
                transactions: [], exclusions: [], startingBalance: null, closingBalance: null,
                rawLines: [], errorCount: 0, statementType: 'current'
            });
        }
        applyBatchFilters();
        elements.resultsArea().classList.remove('hidden');
        elements.dropZone().classList.add('hidden');
    } catch (err) { 
        console.error("Batch Processing Error:", err);
        alert("Error: " + err.message); 
    } finally { 
        hideLoader(); 
    }
}

async function parsePdf(file) {
    const buffer = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument({ data: buffer, password: appState.lastPdfPassword || undefined });
    return new Promise((resolve, reject) => {
        let cancelled = false;
        loadingTask.onPassword = (updatePassword, reason) => {
            requestPdfPassword(file.name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD)
                .then(password => {
                    if (password === null) {
                        cancelled = true;
                        loadingTask.destroy();
                        reject(new Error(`Password entry cancelled for ${file.name}`));
                        return;
                    }
                    appState.lastPdfPassword = password;
                    updatePassword(password);
                })
                .catch(reject);
        };

        loadingTask.promise.then(async doc => {
            try {
                let rawPages = [];
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    const content = await page.getTextContent();
                    rawPages.push({ items: content.items });
                }
                resolve({ rawPages });
            } catch (err) {
                reject(err);
            }
        }).catch(err => {
            if (!cancelled) reject(err);
        });
    });
}

function groupLines(items) {
    items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    const lines = [];
    let cur = null;
    items.forEach(it => {
        const y = it.transform[5];
        if (!cur || Math.abs(cur.y - y) > 2) {
            cur = { y, text: it.str };
            lines.push(cur);
        } else cur.text += (it.transform[4] - (cur.lastX || 0) > 2 ? " " : "") + it.str;
        cur.lastX = it.transform[4] + it.width;
    });
    return lines.map(l => l.text.trim());
}

function regexSplitLines(pageLines) {
    const finalLines = [];
    const dateRegex = /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\b/g;
    pageLines.forEach(line => {
        const matches = [...line.matchAll(dateRegex)];
        if (matches.length > 1) {
            // Split line perfectly at the exact start coordinate of the second transaction date
            const splitIndex = matches[1].index;
            const part1 = line.substring(0, splitIndex).trim();
            const part2 = line.substring(splitIndex).trim();
            finalLines.push(part1, part2);
        } else {
            finalLines.push(line);
        }
    });
    return finalLines;
}

function applyBatchFilters() {
    appState.masterTransactions = [];
    appState.masterExclusions = [];
    let totalErrors = 0;

    appState.batchData.forEach(fileData => {
        fileData.transactions = [];
        fileData.exclusions = [];
        fileData.rawLines = [];
        fileData.startingBalance = null;
        fileData.closingBalance = null;
        
        // 1. Dynamic Pass 1: Generate single-column lines for metadata parsing
        fileData.metadataLines = [];
        fileData.rawPages.forEach((page, pageIdx) => {
            const unsplitLines = groupLines(page.items);
            fileData.metadataLines.push(...unsplitLines);
            if (pageIdx < fileData.rawPages.length - 1) {
                fileData.metadataLines.push("--- PAGE BREAK ---");
            }
        });
        
        // Automatic Classification
        fileData.statementType = classifyStatement(fileData.metadataLines, fileData.rawPages);
        
        // 2. Dynamic Pass 2: Generate dynamic grouping lines based on statement type and split configurations
        fileData.lines = [];
        if (fileData.statementType === 'weekly') {
            fileData.lines = parseWeeklyStatement(fileData.rawPages.map(p => p.items));
        } else {
            fileData.rawPages.forEach((page, pageIdx) => {
                if (fileData.statementType === 'credit') {
                    if (appState.splitMethod === 'center' || appState.splitMethod === 'custom') {
                        const threshold = appState.splitMethod === 'center' ? 297.5 : appState.splitX;
                        const leftItems = [];
                        const rightItems = [];
                        page.items.forEach(it => {
                            if (it.transform[4] < threshold) {
                                leftItems.push(it);
                            } else {
                                rightItems.push(it);
                            }
                        });
                        fileData.lines.push(...groupLines(leftItems));
                        fileData.lines.push("--- COLUMN BREAK ---");
                        fileData.lines.push(...groupLines(rightItems));
                    } else if (appState.splitMethod === 'regex') {
                        const unsplitLines = groupLines(page.items);
                        fileData.lines.push(...regexSplitLines(unsplitLines));
                    } else {
                        // splitMethod === 'none' (No splitting)
                        fileData.lines.push(...groupLines(page.items));
                    }
                } else {
                    // Current accounts are always grouped single-column
                    fileData.lines.push(...groupLines(page.items));
                }

                if (pageIdx < fileData.rawPages.length - 1) {
                    fileData.lines.push("--- PAGE BREAK ---");
                }
            });
        }
        
        let startPeriod = null;
        let endPeriod = null;
        fileData.statementNo = "";
        
        // 3. Metadata Extraction using metadataLines (guaranteed single-column strings!)
        if (fileData.statementType === 'credit') {
            fileData.metadataLines.forEach(text => {
                let uText = text.toUpperCase();
                let mPeriod = text.match(/(?:Statement|Invoice)\s+Period\s+(.*?)\s+to\s+(.*)/i);
                if (mPeriod) {
                    startPeriod = parseCreditCardPeriodDate(mPeriod[1]);
                    endPeriod = parseCreditCardPeriodDate(mPeriod[2]);
                }
                let mNo = text.match(/(?:Statement|Invoice)\s+Number\s+(\d+)/i);
                if (mNo) {
                    fileData.statementNo = mNo[1];
                }
                let mClosing = text.match(/Closing\s+balance\s+(?:on\s+straight\s+)?(-?[\d,.]+[.,]\d{2})/i);
                if (mClosing) {
                    fileData.closingBalance = parseFloat(cleanNum(mClosing[1]));
                }
            });
        } else if (fileData.statementType === 'weekly') {
            let weeklyYear = null;
            let statementDateStr = "";
            fileData.metadataLines.forEach(text => {
                let ym = text.match(/\b(\d{1,2}\s+[A-Za-z]+\s+(20\d{2}|19\d{2}))\b/);
                if (ym && !statementDateStr) {
                    statementDateStr = ym[1];
                    weeklyYear = parseInt(ym[2], 10);
                }
                let mAcc = text.match(/Account:\s*(\d+)/i);
                if (mAcc && !fileData.statementNo) {
                    fileData.statementNo = mAcc[1];
                }
                let mAvail = text.match(/Available\s+Balance:\s*(-?[\d,.]+[.,]\d{2})/i);
                if (mAvail && fileData.closingBalance === null) {
                    fileData.closingBalance = parseFloat(cleanNum(mAvail[1]));
                }
            });
            let fnYearMatch = fileData.filename.match(/\b(20\d{2}|19\d{2})\b/);
            if (!weeklyYear && fnYearMatch) {
                weeklyYear = parseInt(fnYearMatch[1], 10);
            }
            if (!weeklyYear) {
                weeklyYear = new Date().getFullYear();
            }
            fileData.statementYear = weeklyYear;
            fileData.periodText = statementDateStr ? `Weekly (${statementDateStr})` : `Weekly (${weeklyYear})`;
        } else {
            fileData.metadataLines.forEach(text => {
                let uText = text.toUpperCase();
                if (uText.includes("STATEMENT FROM")) {
                    let m = text.match(/Statement\s+from\s+(.*?)\s+to\s+(.*)/i);
                    if (m) {
                        startPeriod = parsePeriodDate(m[1]);
                        endPeriod = parsePeriodDate(m[2]);
                    }
                }
                if (uText.includes("STATEMENT NO")) {
                    let mNo = text.match(/Statement\s+No\s+(\d+)/i);
                    if (mNo) {
                        fileData.statementNo = mNo[1];
                    }
                }
            });
        }
        
        // Guessed Year Fallback
        let guessedYear = new Date().getFullYear();
        let fnMatch = fileData.filename.match(/\b(20\d{2}|19\d{2})\b/);
        if (fnMatch) {
            guessedYear = parseInt(fnMatch[1], 10);
        }
        
        if (fileData.statementType !== 'weekly') {
            if (startPeriod && endPeriod) {
                fileData.periodText = `${formatShortDate(startPeriod)} - ${formatShortDate(endPeriod)}`;
                fileData.statementYear = endPeriod.year;
            } else {
                fileData.periodText = `Year: ${guessedYear}`;
                fileData.statementYear = guessedYear;
            }
        }

        let lastTxn = null;
        let linesSinceLastTxn = 0;
        let pendingContinuation = null;
        let awaitingBalance = false;

        // 4. Statement Type Transaction Parsers
        if (fileData.statementType === 'credit') {
            // --- CREDIT CARD PARSING ENGINE ---
            fileData.lines.forEach(text => {
                if (text === "--- PAGE BREAK ---" || text === "--- COLUMN BREAK ---") {
                    fileData.rawLines.push({ text: text, type: 'info' });
                    return;
                }

                const uText = text.toUpperCase();
                
                // Starting balance check
                if (uText.includes("BALANCE BROUGHT FORWARD")) {
                    let mBf = text.match(/(?:Balance\s+Brought\s+Forward)\s+(-?[\d,.]+[.,]\d{2})/i);
                    if (mBf) {
                        if (fileData.startingBalance === null) {
                            fileData.startingBalance = parseFloat(cleanNum(mBf[1]));
                        }
                        fileData.rawLines.push({ text: text, type: 'info' });
                        return;
                    }
                }

                // Check standard transaction pattern first (prevents accidental junk classification)
                let mStandard = text.match(ccStandardRegex);
                if (mStandard) {
                    if (mStandard[2].toUpperCase().includes("BALANCE BROUGHT FORWARD")) {
                        return;
                    }
                    let parsedDate = parseCcDate(mStandard[1]);
                    let cleanDesc = cleanCcDetails(mStandard[2]);
                    let zarAmt = cleanNum(mStandard[3]);
                    
                    lastTxn = {
                        date: parsedDate.dateDisplay,
                        year: parsedDate.year,
                        details: cleanDesc || "Transaction",
                        category: getCategory(cleanDesc),
                        amount: zarAmt,
                        balance: "0.00",
                        source: fileData.filename
                    };
                    fileData.transactions.push(lastTxn);
                    fileData.rawLines.push({ text: text, type: 'txn' });
                    linesSinceLastTxn = 0;
                    return;
                }

                // Log or ignore non-transaction lines
                const junkReason = isJunk(text);
                if (junkReason) {
                    fileData.exclusions.push({ reason: junkReason, text: text, source: fileData.filename });
                    fileData.rawLines.push({ text: text, type: 'junk' });
                } else {
                    fileData.rawLines.push({ text: text, type: 'ignored' });
                }
            });
        } else if (fileData.statementType === 'weekly') {
            // --- WEEKLY STATEMENT PARSING ENGINE ---
            fileData.lines.forEach(text => {
                if (text === "--- PAGE BREAK ---") {
                    fileData.rawLines.push({ text: text, type: 'info' });
                    return;
                }

                const uText = text.toUpperCase();

                if (uText.includes("BALANCE BROUGHT FORWARD")) {
                    const m = text.match(/BALANCE BROUGHT FORWARD\s+(-?[\d,.\s]+-?)/i);
                    if (m) {
                        if (fileData.startingBalance === null) {
                            fileData.startingBalance = parseFloat(cleanNum(m[1]));
                        }
                        fileData.rawLines.push({ text: text, type: 'info' });
                        return;
                    }
                }

                const m = text.match(valPattern);
                if (m) {
                    const details = cleanDetails(text.substring(0, m.index).trim());
                    const dateStr = m[2];
                    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    const dParts = dateStr.split(/\s+/);
                    const day = dParts[0];
                    const mIdx = parseInt(dParts[1], 10) - 1;
                    const formattedDate = (mIdx >= 0 && mIdx < 12) ? `${day} ${monthNames[mIdx]}` : dateStr;

                    lastTxn = {
                        date: formattedDate,
                        year: fileData.statementYear || guessedYear,
                        details: details || "Transaction",
                        category: getCategory(details),
                        amount: cleanNum(m[1]),
                        balance: cleanNum(m[3]),
                        source: fileData.filename
                    };
                    fileData.transactions.push(lastTxn);
                    fileData.rawLines.push({ text: text, type: 'txn' });
                    return;
                }

                const junkReason = isJunk(text);
                if (junkReason) {
                    fileData.exclusions.push({ reason: junkReason, text: text, source: fileData.filename });
                    fileData.rawLines.push({ text: text, type: 'junk' });
                } else {
                    fileData.rawLines.push({ text: text, type: 'ignored' });
                }
            });
        } else {
            // --- CURRENT ACCOUNT PARSING ENGINE ---
            fileData.lines.forEach(text => {
                if (text === "--- PAGE BREAK ---") {
                    if (lastTxn && !appState.filters.strict) {
                        const hasHashHash = lastTxn.details.includes("##");
                        if (!hasHashHash) {
                            pendingContinuation = lastTxn;
                        }
                    }
                    awaitingBalance = true;
                    fileData.rawLines.push({ text: text, type: 'info' });
                    return;
                }

                const uText = text.toUpperCase();
                
                if (awaitingBalance) {
                    if (uText.includes("BALANCE BROUGHT FORWARD")) {
                        const m = text.match(/(BALANCE BROUGHT FORWARD)\s+(?:(\d{2}\s+\d{2})\s+)?(-?[\d,.\s]+-?)/i);
                        if (m) {
                            if (fileData.startingBalance === null) {
                                fileData.startingBalance = parseFloat(cleanNum(m[3]));
                            }
                            fileData.rawLines.push({ text: text, type: 'info' });
                            lastTxn = null; 
                            awaitingBalance = false;
                            return;
                        }
                    }
                    fileData.rawLines.push({ text: text, type: 'ignored' });
                    return;
                }

                if (uText.includes("BALANCE BROUGHT FORWARD")) {
                    const m = text.match(/(BALANCE BROUGHT FORWARD)\s+(?:(\d{2}\s+\d{2})\s+)?(-?[\d,.\s]+-?)/i);
                    if (m) {
                        if (fileData.startingBalance === null) {
                            fileData.startingBalance = parseFloat(cleanNum(m[3]));
                        }
                        fileData.rawLines.push({ text: text, type: 'info' });
                        lastTxn = null; 
                        return;
                    }
                }

                const junkReason = isJunk(text);
                const m = text.match(valPattern);
                if (m) {
                    pendingContinuation = null;
                    awaitingBalance = false;
                    
                    const details = cleanDetails(text.substring(0, m.index).trim());
                    const dateStr = m[2];
                    const txnYear = getTransactionYear(dateStr, startPeriod, endPeriod, guessedYear);
                    
                    lastTxn = { 
                        date: dateStr, 
                        year: txnYear,
                        details: details || "Transaction", 
                        category: getCategory(details), amount: cleanNum(m[1]), 
                        balance: cleanNum(m[3]), source: fileData.filename 
                    };
                    fileData.transactions.push(lastTxn);
                    fileData.rawLines.push({ text: text, type: 'txn' });
                    linesSinceLastTxn = 0;
                    return;
                }
                
                linesSinceLastTxn++;
                
                if (lastTxn && !appState.filters.strict && linesSinceLastTxn === 1) {
                    const hasHashHash = lastTxn.details.includes("##");
                    if (!hasHashHash && !junkReason) {
                        const cleaned = cleanDetails(text);
                        if (cleaned) {
                            lastTxn.details += " | " + cleaned;
                            lastTxn.category = getCategory(lastTxn.details);
                            fileData.rawLines.push({ text: text, type: 'txn-cont' });
                            return;
                        }
                    }
                }
                
                if (pendingContinuation && !appState.filters.strict && !junkReason) {
                    const cleaned = cleanDetails(text);
                    if (cleaned) {
                        pendingContinuation.details += " | " + cleaned;
                        pendingContinuation.category = getCategory(pendingContinuation.details);
                        fileData.rawLines.push({ text: text, type: 'txn-cont' });
                        pendingContinuation = null;
                        return;
                    }
                }
                
                if (junkReason) {
                    fileData.exclusions.push({ reason: junkReason, text: text, source: fileData.filename });
                    fileData.rawLines.push({ text: text, type: 'junk' });
                } else {
                    fileData.rawLines.push({ text: text, type: 'ignored' });
                }
            });
        }

        fileData.errorCount = performFileSanity(fileData);
        totalErrors += fileData.errorCount;
        appState.masterTransactions.push(...fileData.transactions);
        appState.masterExclusions.push(...fileData.exclusions);
    });

    renderAll(totalErrors);
}

function getCategory(details) {
    for (let catRule of appState.categories) {
        const parts = catRule.split(':');
        if (parts.length < 2) continue;
        const label = parts[0].trim();
        const keyword = parts.slice(1).join(':').trim();
        if (label && keyword && details.toLowerCase().includes(keyword.toLowerCase())) return label;
    }
    return "Uncategorized";
}

function performFileSanity(data) {
    let prev = data.startingBalance;
    let errors = 0;

    if (data.statementType === 'credit') {
        data.transactions.forEach(t => {
            if (prev !== null) {
                const exp = Math.round((prev + parseFloat(t.amount)) * 100) / 100;
                t.balance = exp.toFixed(2);
                t.sanity = 'ok';
                prev = exp;
            } else {
                t.sanity = 'unknown';
            }
            
            // Length check
            const parts = t.details.split(" | ");
            for (let part of parts) {
                if (part.length > 60) {
                    t.sanity = 'err';
                    t.math = `Error: Reference > 60 chars`;
                    errors++;
                    break;
                }
            }
        });

        // Verification against closing balance
        if (prev !== null && data.closingBalance !== null) {
            const diff = Math.abs(prev - data.closingBalance);
            if (diff > 0.01) {
                errors++;
                if (data.transactions.length > 0) {
                    const lastTxn = data.transactions[data.transactions.length - 1];
                    lastTxn.sanity = 'err';
                    lastTxn.math = `Closing mismatch! Calculated: ${prev.toFixed(2)}, Statement: ${data.closingBalance.toFixed(2)}`;
                }
            }
        }
    } else {
        data.transactions.forEach(t => {
            if (prev !== null) {
                const exp = Math.round((prev + parseFloat(t.amount)) * 100) / 100;
                const act = parseFloat(t.balance);
                t.sanity = Math.abs(exp - act) < 0.01 ? 'ok' : 'err';
                t.math = `Exp: ${exp.toFixed(2)}`;
                if (t.sanity === 'err') errors++;
                prev = act;
            } else t.sanity = 'unknown';
            
            // Length check
            const parts = t.details.split(" | ");
            for (let part of parts) {
                if (part.length > 60) {
                    t.sanity = 'err';
                    t.math = `Error: Reference > 60 chars`;
                    errors++;
                    break;
                }
            }
        });
    }
    return errors;
}

function isJunk(t) {
    if (!t || t.length < 2) return "Short";
    if (t.length > 60) return "Disclaimer/Noise Pattern";
    if (appState.filters.regex) {
        if (/^\d{9,13}$/.test(t)) return "Account Pattern";
        if (/^\d{4}$/.test(t)) return "Postcode Pattern";
    }
    if (appState.filters.keyword) {
        for (let k of appState.junkKeywords) if (t.toLowerCase().includes(k.toLowerCase())) return k;
    }
    return null;
}

function cleanDetails(d) {
    let c = d;
    if (appState.filters.keyword) {
        appState.junkKeywords.forEach(k => {
            const regex = new RegExp(escapeRegExp(k), 'gi');
            c = c.replace(regex, '');
        });
    }
    return c.trim().replace(/\s+/g, ' ');
}

function cleanCcDetails(d) {
    let c = d.replace(/^[|#\s]+/, ''); // remove leading separators
    if (appState.filters.keyword) {
        appState.junkKeywords.forEach(k => {
            const regex = new RegExp(escapeRegExp(k), 'gi');
            c = c.replace(regex, '');
        });
    }
    return c.trim().replace(/\s+/g, ' ');
}

function cleanNum(v) {
    let n = v.replace(/\s/g, '');
    let neg = n.endsWith('-') || n.startsWith('-');
    n = n.replace(/[^\d.,]/g, '');
    if (n.length >= 3 && (n[n.length-3] === '.' || n[n.length-3] === ',')) {
        const int = n.slice(0,-3).replace(/[^\d]/g, '');
        n = `${int}.${n.slice(-2)}`;
    } else n = n.replace(/[^\d]/g, '');
    return (neg ? '-' : '') + n;
}

function parseCcDate(dateStr) {
    let parts = dateStr.trim().split(/\s+/);
    if (parts.length >= 3) {
        let day = parts[0];
        let month = parts[1];
        let yearShort = parts[2];
        let yearFull = 2000 + parseInt(yearShort, 10);
        return {
            dateDisplay: `${day.padStart(2, '0')} ${month}`,
            year: yearFull
        };
    }
    return { dateDisplay: dateStr, year: null };
}

function splitDetails(detailsStr) {
    const parts = (detailsStr || "").split(" | ").map(p => p.trim());
    let mainDetails = parts[0] || "";
    
    const codeMatch = mainDetails.match(/\b\d{4}\b/);
    const details2 = codeMatch ? codeMatch[0] : "";
    
    let details1 = mainDetails;
    if (codeMatch) {
        details1 = mainDetails.replace(codeMatch[0], "").replace(/\s+/g, " ").trim();
    }
    
    const details3 = parts.slice(1).join(" | ") || "";
    return { details1, details2, details3 };
}

function renderAll(totalErrors) {
    try {
        // 1. Master Table
        const table = elements.txnTable();
        table.innerHTML = '';
        let lastSource = null;

        appState.masterTransactions.forEach(t => {
            const row = document.createElement('tr');
            if (t.source !== lastSource) {
                row.id = sanitizeId(t.source);
                lastSource = t.source;
            }
            const amtCls = parseFloat(t.amount) < 0 ? 'text-danger' : 'text-success';
            const { details1, details2, details3 } = splitDetails(t.details);
            row.innerHTML = `
                <td>${t.date}</td>
                <td>${t.year || ""}</td>
                <td class="wrap">${details1}</td>
                <td class="wrap">${details2}</td>
                <td class="wrap">${details3}</td>
                <td><span class="badge" style="background:rgba(56,189,248,0.1); color:var(--accent-color);">${t.category}</span></td>
                <td class="text-right ${amtCls}">${parseFloat(t.amount).toFixed(2)}</td>
                <td class="text-right">${parseFloat(t.balance).toFixed(2)}</td>
                <td style="color:var(--text-secondary); font-size:0.65rem;">${t.source}</td>
                <td><div class="sanity-dot sanity-${t.sanity}"></div> ${t.sanity === 'err' ? '<span class="math-note">'+t.math+'</span>' : ''}</td>
            `;
            table.appendChild(row);
        });

        // 2. Dashboard
        elements.fileCount().textContent = appState.batchData.length;
        elements.txnCount().textContent = appState.masterTransactions.length;
        elements.batchStatus().innerHTML = totalErrors > 0 
            ? `<span class="text-danger"><i data-lucide="alert-circle" style="width:14px;height:14px;vertical-align:middle;"></i> ${totalErrors} Errors</span>` 
            : `<span class="text-success"><i data-lucide="check-circle" style="width:14px;height:14px;vertical-align:middle;"></i> Math OK</span>`;
        
        const dashboard = elements.dashboard();
        dashboard.innerHTML = '';
        appState.batchData.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            const fileId = sanitizeId(file.filename);
            const ccBadge = file.statementType === 'credit' 
                ? '<span class="badge-statement-type cc">Credit Card</span>'
                : (file.statementType === 'weekly'
                    ? '<span class="badge-statement-type weekly">Weekly Statement</span>'
                    : '<span class="badge-statement-type current">Current Account</span>');
                
            item.innerHTML = `
                <div class="file-item-header">
                    <span class="file-name clickable" onclick="jumpToFile('${fileId}')" title="Jump to this file">${file.filename}</span>
                    <div class="file-actions">
                        <button class="icon-btn" onclick="exportOne('${file.filename}', 'csv')"><i data-lucide="file-text" style="width:14px;"></i></button>
                        <button class="icon-btn" onclick="exportOne('${file.filename}', 'xlsx')"><i data-lucide="file-spreadsheet" style="width:14px;"></i></button>
                    </div>
                </div>
                <div class="file-metadata" style="margin-top: 4px; color: var(--text-secondary); font-size: 0.7rem; display: flex; flex-direction: column; gap: 2px;">
                    ${file.statementNo ? `<span>Statement No: <strong>${file.statementNo}</strong></span>` : ''}
                    <span>Period: <strong>${file.periodText}</strong></span>
                    ${ccBadge}
                </div>
                <div class="file-stats" style="margin-top: 6px;">
                    <span>${file.transactions.length} rows</span>
                    <span class="file-badge ${file.errorCount > 0 ? 'err' : 'ok'}">${file.errorCount > 0 ? file.errorCount + ' Errors' : 'Verified'}</span>
                </div>
            `;
            dashboard.appendChild(item);
        });

        // 3. Raw Feed
        const raw = elements.rawOutput();
        raw.innerHTML = '';
        appState.batchData.forEach(file => {
            const div = document.createElement('div');
            div.className = 'raw-line file-break';
            div.textContent = `SOURCE: ${file.filename} (${file.statementType.toUpperCase()})`;
            raw.appendChild(div);
            file.rawLines.forEach((l, i) => {
                const lineDiv = document.createElement('div');
                lineDiv.className = `raw-line ${l.type}`;
                lineDiv.innerHTML = `<span style="color:#475569; width:40px;">${i+1}</span>${l.type==='txn'?'<span class="badge badge-txn">TXN</span>':l.type==='junk'?'<span class="badge badge-junk">JUNK</span>':''} <span>${l.text}</span>`;
                raw.appendChild(lineDiv);
            });
        });

        // 4. Exclusions
        const exclusionTable = elements.exclusionTable();
        exclusionTable.innerHTML = '';
        appState.masterExclusions.forEach(ex => {
            const row = document.createElement('tr');
            row.innerHTML = `<td><span class="text-danger">${ex.reason}</span></td><td class="wrap">${ex.text}</td><td style="font-size:0.7rem;">${ex.source}</td>`;
            exclusionTable.appendChild(row);
        });
        
        refreshIcons();
    } catch (renderErr) {
        console.error("Rendering Error:", renderErr);
    }
}

window.jumpToFile = (id) => {
    const el = document.getElementById(id);
    if (el) {
        document.querySelector('.tab-btn[data-tab="parsed"]').click();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.style.background = 'rgba(56, 189, 248, 0.2)';
        setTimeout(() => el.style.background = '', 2000);
    }
};

function exportAll(type) {
    const data = appState.masterTransactions.map(t => {
        const { details1, details2, details3 } = splitDetails(t.details);
        return { 
            Date: t.date, 
            Year: t.year || "",
            "Details 1 (Type)": details1, 
            "Details 2 (Code)": details2, 
            "Details 3 (Additional)": details3, 
            Category: t.category, 
            Amount: t.amount, 
            Balance: t.balance, 
            Source: t.source 
        };
    });
    downloadData(data, `Master_Batch_Export`, type);
}

window.exportOne = (filename, type) => {
    const file = appState.batchData.find(d => d.filename === filename);
    if (!file) return;
    const data = file.transactions.map(t => {
        const { details1, details2, details3 } = splitDetails(t.details);
        return { 
            Date: t.date, 
            Year: t.year || "",
            "Details 1 (Type)": details1, 
            "Details 2 (Code)": details2, 
            "Details 3 (Additional)": details3, 
            Category: t.category, 
            Amount: t.amount, 
            Balance: t.balance 
        };
    });
    downloadData(data, `${filename.replace('.pdf', '')}_Parsed`, type);
};

function downloadData(data, name, type) {
    if (!data.length) return;
    const method = elements.downloadMethod().value;
    
    if (type === 'csv') {
        const cols = Object.keys(data[0]);
        const csv = cols.join(",") + "\n" + data.map(r => cols.map(c => `"${r[c]}"`).join(",")).join("\n");
        
        if (method === 'clipboard') {
            navigator.clipboard.writeText(csv).then(() => {
                alert("CSV Data Copied to Clipboard! You can paste it into Excel or any text file.");
            }).catch(err => {
                alert("Clipboard blocked. Using modal fallback...");
                showTextModal(`CSV Export: ${name}`, csv);
            });
        } else if (method === 'show') {
            showTextModal(`CSV Export: ${name}`, csv);
        } else if (method === 'dataurl') {
            const u = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
            downloadUrl(u, `${name}.csv`);
        } else {
            downloadBlob(csv, `${name}.csv`, 'text/csv');
        }
    } else {
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Data");
        
        if (method === 'clipboard') {
            const out = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
            navigator.clipboard.writeText(out).then(() => {
                alert("Excel Base64 String Copied to Clipboard! You can convert it using online base64 decoders or paste it.");
            }).catch(err => {
                showTextModal(`Excel Base64: ${name}`, out);
            });
        } else if (method === 'show') {
            const out = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
            showTextModal(`Excel Base64: ${name}`, out);
        } else if (method === 'dataurl') {
            const out = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
            const u = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + out;
            downloadUrl(u, `${name}.xlsx`);
        } else {
            const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            downloadBlob(out, `${name}.xlsx`, 'application/octet-stream');
        }
    }
}

function showTextModal(title, text) {
    elements.textModalTitle().textContent = title;
    elements.textModalArea().value = text;
    const modal = elements.textModal();
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.add('visible'), 10);
}

function downloadBlob(content, name, mime) {
    const b = new Blob([content], { type: mime });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(u); }, 0);
}

function downloadUrl(url, name) {
    const a = document.createElement('a');
    a.href = url; 
    a.download = name;
    document.body.appendChild(a); 
    a.click();
    setTimeout(() => { 
        document.body.removeChild(a); 
    }, 0);
}

function showLoader(t) { elements.loaderText().textContent = t; elements.loader().classList.remove('hidden'); }
function hideLoader() { elements.loader().classList.add('hidden'); }

window.addEventListener('load', init);
