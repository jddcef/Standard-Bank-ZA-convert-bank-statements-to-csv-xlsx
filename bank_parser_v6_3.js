// BankFlow v6.3 - Robust Batch Dashboard (Display Fix)
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
    filters: { keyword: true, regex: true, strict: true, sanity: true },
    masterTransactions: [],
    masterExclusions: []
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
    tabs: () => document.querySelectorAll('.tab-btn')
};

const valPattern = /(-?[\d\s.,]+[.,]\d{2}-?)\s+(\d{2}\s+\d{2})\s+(-?[\d\s.,]+[.,]\d{2}-?)/;

function init() {
    const savedJunk = localStorage.getItem('bankflow_v63_junk');
    const savedCats = localStorage.getItem('bankflow_v63_cats');
    if (savedJunk) appState.junkKeywords = savedJunk.split('\n').filter(l => l.trim());
    if (savedCats) appState.categories = savedCats.split('\n').filter(l => l.trim());
    elements.junkInput().value = appState.junkKeywords.join('\n');
    elements.categoryInput().value = appState.categories.join('\n');
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

    elements.saveConfig().onclick = () => {
        appState.junkKeywords = elements.junkInput().value.split('\n').map(l => l.trim()).filter(l => l);
        appState.categories = elements.categoryInput().value.split('\n').map(l => l.trim()).filter(l => l);
        localStorage.setItem('bankflow_v63_junk', elements.junkInput().value);
        localStorage.setItem('bankflow_v63_cats', elements.categoryInput().value);
        elements.closeConfig().onclick();
        applyBatchFilters();
    };

    window.onscroll = () => elements.jumpToTop().classList.toggle('visible', window.scrollY > 300);
    elements.jumpToTop().onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    
    document.getElementById('exportMasterCsv').onclick = () => exportAll('csv');
    document.getElementById('exportMasterXlsx').onclick = () => exportAll('xlsx');
}

async function processFiles(files) {
    showLoader(`Queueing ${files.length} Files...`);
    try {
        for (let file of files) {
            if (!file.name.toLowerCase().endsWith('.pdf')) continue;
            if (appState.batchData.some(d => d.filename === file.name && d.size === file.size)) continue;
            showLoader(`Parsing ${file.name}...`);
            const lines = await parsePdf(file);
            appState.batchData.push({ 
                filename: file.name, size: file.size, lines: lines, 
                transactions: [], exclusions: [], startingBalance: null, 
                rawLines: [], errorCount: 0 
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
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
    let lines = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        lines.push(...groupLines(content.items));
    }
    return lines;
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

function applyBatchFilters() {
    appState.masterTransactions = [];
    appState.masterExclusions = [];
    let totalErrors = 0;

    appState.batchData.forEach(fileData => {
        fileData.transactions = [];
        fileData.exclusions = [];
        fileData.rawLines = [];
        fileData.startingBalance = null;
        let lastTxn = null;

        fileData.lines.forEach(text => {
            if (text.toUpperCase().includes("BALANCE BROUGHT FORWARD")) {
                const m = text.match(/(BALANCE BROUGHT FORWARD)\s+(\d{2}\s+\d{2})\s+([\d,.\s]+)/i);
                if (m) {
                    fileData.startingBalance = parseFloat(cleanNum(m[3]));
                    fileData.rawLines.push({ text: text, type: 'info' });
                    return;
                }
            }
            const junkReason = isJunk(text);
            const m = text.match(valPattern);
            if (m) {
                const details = cleanDetails(text.substring(0, m.index).trim());
                lastTxn = { 
                    date: m[2], details: details || "Transaction", 
                    category: getCategory(details), amount: cleanNum(m[1]), 
                    balance: cleanNum(m[3]), source: fileData.filename 
                };
                fileData.transactions.push(lastTxn);
                fileData.rawLines.push({ text: text, type: 'txn' });
                return;
            }
            if (lastTxn && !appState.filters.strict && !junkReason) {
                const cleaned = cleanDetails(text);
                if (cleaned) {
                    lastTxn.details += " | " + cleaned;
                    lastTxn.category = getCategory(lastTxn.details);
                    fileData.rawLines.push({ text: text, type: 'txn-cont' });
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
    data.transactions.forEach(t => {
        if (prev !== null) {
            const exp = Math.round((prev + parseFloat(t.amount)) * 100) / 100;
            const act = parseFloat(t.balance);
            t.sanity = Math.abs(exp - act) < 0.01 ? 'ok' : 'err';
            t.math = `Exp: ${exp.toFixed(2)}`;
            if (t.sanity === 'err') errors++;
            prev = act;
        } else t.sanity = 'unknown';
    });
    return errors;
}

function isJunk(t) {
    if (!t || t.length < 2) return "Short";
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

function cleanNum(v) {
    if (v === null || v === undefined) return '';

    let n = String(v).replace(/\s+/g, '');
    const neg = n.startsWith('-') || n.endsWith('-');
    n = n.replace(/[^\d,.-]/g, '').replace(/-/g, '');
    if (!n) return '';

    if (n.includes(',') && n.includes('.')) {
        const lastComma = n.lastIndexOf(',');
        const lastDot = n.lastIndexOf('.');
        const decimalSep = lastComma > lastDot ? ',' : '.';
        const groupSep = decimalSep === ',' ? '.' : ',';
        n = n.replace(new RegExp(escapeRegExp(groupSep), 'g'), '').replace(decimalSep, '.');
    } else if (n.includes(',')) {
        const lastComma = n.lastIndexOf(',');
        const fractionDigits = n.slice(lastComma + 1).length;
        if (fractionDigits === 2 && lastComma > 0) {
            n = n.replace(/,/g, '.');
        } else {
            n = n.replace(/,/g, '');
        }
    } else if (n.includes('.')) {
        const parts = n.split('.');
        if (parts.length > 2) {
            const fraction = parts.pop();
            n = `${parts.join('')}.${fraction}`;
        }
    }

    return (neg ? '-' : '') + n;
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
            row.innerHTML = `
                <td>${t.date}</td><td class="wrap">${t.details}</td>
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
            item.innerHTML = `
                <div class="file-item-header">
                    <span class="file-name clickable" onclick="jumpToFile('${fileId}')" title="Jump to this file">${file.filename}</span>
                    <div class="file-actions">
                        <button class="icon-btn" onclick="exportOne('${file.filename}', 'csv')"><i data-lucide="file-text" style="width:14px;"></i></button>
                        <button class="icon-btn" onclick="exportOne('${file.filename}', 'xlsx')"><i data-lucide="file-spreadsheet" style="width:14px;"></i></button>
                    </div>
                </div>
                <div class="file-stats">
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
            div.textContent = `SOURCE: ${file.filename}`;
            raw.appendChild(div);
            file.rawLines.forEach((l, i) => {
                const lineDiv = document.createElement('div');
                lineDiv.className = `raw-line ${l.type}`;
                lineDiv.innerHTML = `<span style="color:#475569; width:40px;">${i+1}</span>${l.type==='txn'?'<span class="badge badge-txn">TXN</span>':l.type==='junk'?'<span class="badge badge-junk">JUNK</span>':''} <span>${l.text}</span>`;
                raw.appendChild(lineDiv);
            });
        });

        // 4. Exclusions (FIXED TYPO HERE)
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
    const data = appState.masterTransactions.map(t => ({ 
        Date: t.date, Details: t.details, Category: t.category, 
        Amount: t.amount, Balance: t.balance, Source: t.source 
    }));
    downloadData(data, `Master_Batch_Export`, type);
}

window.exportOne = (filename, type) => {
    const file = appState.batchData.find(d => d.filename === filename);
    if (!file) return;
    const data = file.transactions.map(t => ({ 
        Date: t.date, Details: t.details, Category: t.category, 
        Amount: t.amount, Balance: t.balance 
    }));
    downloadData(data, `${filename.replace('.pdf', '')}_Parsed`, type);
};

function downloadData(data, name, type) {
    if (!data.length) return;
    if (type === 'csv') {
        const cols = Object.keys(data[0]);
        const csv = cols.join(",") + "\n" + data.map(r => cols.map(c => `"${r[c]}"`).join(",")).join("\n");
        downloadBlob(csv, `${name}.csv`, 'text/csv');
    } else {
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Data");
        const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        downloadBlob(out, `${name}.xlsx`, 'application/octet-stream');
    }
}

function downloadBlob(content, name, mime) {
    const b = new Blob([content], { type: mime });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(u); }, 0);
}

function showLoader(t) { elements.loaderText().textContent = t; elements.loader().classList.remove('hidden'); }
function hideLoader() { elements.loader().classList.add('hidden'); }

window.addEventListener('load', init);
