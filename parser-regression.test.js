const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('bank_parser_v6_3.js', 'utf8');

function loadParserContext() {
  const elements = {};
  const createElement = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => ({
      addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} },
      value: ''
    }),
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
    onclick: null,
    ondragover: null,
    ondrop: null,
    onchange: null,
    click() {},
    scrollIntoView() {}
  });

  const document = {
    getElementById: (id) => {
      if (!elements[id]) elements[id] = createElement();
      return elements[id];
    },
    querySelectorAll: () => [],
    querySelector: () => ({ classList: { add() {}, remove() {}, toggle() {} } }),
    createElement,
    body: { appendChild() {}, removeChild() {} }
  };

  const windowObj = {
    addEventListener() {},
    scrollTo() {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    'pdfjs-dist/build/pdf': {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 0,
          getPage: async () => ({
            getTextContent: async () => ({ items: [] })
          })
        })
      })
    },
    localStorage: { getItem: () => null, setItem() {} }
  };

  const context = {
    window: windowObj,
    document,
    localStorage: windowObj.localStorage,
    console,
    setTimeout,
    clearTimeout,
    Blob,
    URL: windowObj.URL
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('cleanNum normalizes South African amount formats', () => {
  const context = loadParserContext();
  const cases = [
    ['1 234,50', '1234.50'],
    ['-1 234,50', '-1234.50'],
    ['1,234.50', '1234.50'],
    ['1.234,50', '1234.50'],
    ['-1234.50', '-1234.50'],
    ['10 000.00', '10000.00'],
    ['R 1 234,50', '1234.50']
  ];

  for (const [input, expected] of cases) {
    assert.equal(vm.runInContext(`cleanNum(${JSON.stringify(input)})`, context), expected);
  }
});

test('transaction pattern accepts values with spaces and decimal separators', () => {
  const context = loadParserContext();
  const valPattern = /(-?[\d\s.,]+[.,]\d{2}-?)\s+(\d{2}\s+\d{2})\s+(-?[\d\s.,]+[.,]\d{2}-?)/;

  for (const sample of [
    '-1 234,50 17 11 2 345,67',
    '1,234.50 18 11 2,345.67',
    '1234.50 11 11 2456.00'
  ]) {
    const match = sample.match(valPattern);
    assert.ok(match, `Expected a transaction match for ${sample}`);
    assert.ok(match[1]);
    assert.ok(match[2]);
    assert.ok(match[3]);
  }
});
