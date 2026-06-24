const CONFIG_DEFAULTS = {
  SPREADSHEET_NAME: 'Family Budget Tracker',
  WALLET_API_BASE_URL: 'https://rest.budgetbakers.com/wallet',
  TIMEZONE: 'Europe/Dublin',
  CURRENCY: 'EUR',
  WHATSAPP_ENABLED: 'FALSE',
  WHATSAPP_PHONE_NUMBER_ID: '1208060619049544',
  WHATSAPP_TO_NUMBERS: '+23057937859',
  WHATSAPP_SUMMARY_TOP_N: '8',
  SUMMARY_HOUR: '9',
  CASHFLOW_CAPTURE_HOUR: '22',
  INCLUDE_ALL_ACCOUNTS: 'TRUE',
  FX_RATES_TO_EUR_JSON: '{"EUR":1}',
  DEFAULT_REPORT_TOP_N: '10',
  BUDGET_MONTH_START_DAY: '25',
  WHATSAPP_MESSAGE_STALE_SECONDS: '300',
  CLAUDE_POLL_TIMEOUT_SECONDS: '55',
  CLAUDE_POLL_INTERVAL_MS: '2000',
  CLAUDE_CONTEXT_MAX_BYTES: '30000000'
};

const SHEETS = {
  SETTINGS: 'Settings',
  CATEGORIES: 'Categories',
  ACCOUNTS: 'Accounts',
  TRANSACTIONS: 'Transactions',
  BUDGETS: 'Budget',
  SUMMARY: 'Summary',
  CASH_FLOW_BALANCES: 'CashFlowPeriodBalances',
  YESTERDAY_EXPENSES: 'YesterdayExpenses',
  SCHEMA_REVIEW: 'SchemaReview',
  RUN_LOG: 'RunLog',
  MESSAGE_LOG: 'MessageLog'
};

const HEADERS = {
  Settings: ['Key', 'Value', 'Notes'],
  Categories: ['CategoryId', 'ParentCategoryId', 'Category', 'FullPath', 'Level', 'Type', 'Enabled', 'Report'],
  Accounts: ['Name', 'Currency', 'Include', 'RawType', 'Balance', 'Comment', 'AccountId'],
  Transactions: ['RecordId', 'Date', 'Month', 'AccountId', 'Account', 'CategoryId', 'Category', 'Type', 'AmountEUR', 'OriginalAmount', 'OriginalCurrency', 'Note', 'CategoryType'],
  Budgets: ['Category', 'Period', 'Forecast Type', 'BudgetEUR', 'Include in Report?', 'Include in Expense Calculations', 'CurrentMonthSpentEUR', 'RemainingEUR', 'UsedPercent', 'ForecastEUR', 'ForecastVsBudgetEUR', 'BaselineMonth1EUR', 'BaselineMonth2EUR', 'BaselineMonth3EUR', '3MonthBaselineAverageEUR', 'CategoryId', 'ParentCategoryId', 'CategoryType', 'Depth', 'Path', 'RowType', 'Effective in Total?'],
  Summary: ['Budget Line', 'BudgetEUR', 'SpentEUR', 'RemainingEUR', 'UsedPercent', 'ForecastEUR', 'ForecastVsBudgetEUR'],
  CashFlowPeriodBalances: ['PeriodStart', 'PeriodEnd', 'Period', 'CapturedAt', 'RowType', 'Account', 'AccountId', 'Currency', 'ClosingBalance', 'ClosingBalanceEUR', 'Source', 'Notes'],
  YesterdayExpenses: ['Date', 'Account', 'Category', 'AmountEUR', 'Note', 'RecordId'],
  SchemaReview: ['Table', 'FieldPath', 'InferredTypes', 'ExampleValues', 'Notes'],
  RunLog: ['Timestamp', 'Level', 'Action', 'Message'],
  MessageLog: ['Timestamp', 'MessageId', 'From', 'InboundTimestamp', 'Text', 'Status', 'ErrorCode', 'ErrorMessage', 'ClaudeSessionId', 'ClaudeRequestIds', 'ClaudeEventSummary', 'ContextBytes', 'TransactionCount', 'OutboundAt', 'OutboundMessageId', 'Notes']
};

const STANDARD_BUDGET_ICON_LIBRARY = {
  'alcohol, tobacco': '🍷',
  'bar cafe': '☕',
  'clothes & shoes': '👕',
  'drugstore': '🧴',
  'electronics & accessories': '💻',
  'financial expenses': '🏦',
  'food & drinks': '🍽️',
  'fuel': '⛽',
  'groceries': '🛒',
  'home & garden': '🏡',
  'housing': '🏠',
  'income': '💰',
  'investments': '📈',
  'kids': '🧸',
  'life & entertainment': '🎭',
  'others': '📦',
  'parking': '🅿️',
  'pc, communication': '📱',
  'restaurants & fast food': '🍔',
  'shopping': '🛍️',
  'transportation': '🚗',
  'unknown': '❓',
  'vehicle': '🚘',
  'vehicle maintenance': '🔧'
};

const ERROR_CODES = {
  DUPLICATE_IGNORED: 'ERR_DUPLICATE_IGNORED',
  STALE_MESSAGE: 'ERR_STALE_MESSAGE',
  UNSUPPORTED_MESSAGE: 'ERR_UNSUPPORTED_MESSAGE',
  WHATSAPP_SEND: 'ERR_WHATSAPP_SEND',
  CLAUDE_CONFIG: 'ERR_CLAUDE_CONFIG',
  CLAUDE_TIMEOUT: 'ERR_CLAUDE_TIMEOUT',
  CLAUDE_MCP_AUTH: 'ERR_CLAUDE_MCP_AUTH',
  CLAUDE_CONTEXT_TOO_LARGE: 'ERR_CLAUDE_CONTEXT_TOO_LARGE',
  CLAUDE_EMPTY_REPLY: 'ERR_CLAUDE_EMPTY_REPLY',
  WALLET_AUTH: 'ERR_WALLET_AUTH',
  WALLET_API: 'ERR_WALLET_API'
};

const BB_SCHEMA_REFERENCE = [
  ['categories', 'id', 'string', 'Category primary key from BudgetBakers audit.'],
  ['categories', 'parentId', 'string?', 'Parent category id; mostly blank, used for category hierarchy.'],
  ['categories', 'name', 'string', 'Category display name.'],
  ['categories', 'group.id', 'string', 'BudgetBakers category group identifier.'],
  ['categories', 'group.name', 'string', 'BudgetBakers category group display name.'],
  ['categories', 'enabled', 'boolean', 'Wallet category enabled flag.'],
  ['categories', 'archived', 'boolean', 'Wallet category archived flag.'],
  ['accounts', 'id', 'string', 'Account primary key.'],
  ['accounts', 'name', 'string', 'Account display name.'],
  ['accounts', 'accountType', 'string', 'Wallet account type, for example Cash or CurrentAccount.'],
  ['accounts', 'balance.currencyCode', 'string', 'Account currency; observed EUR and ZAR.'],
  ['accounts', 'initialBalance.currencyCode', 'string', 'Fallback account currency.'],
  ['accounts', 'excludeFromStats', 'boolean', 'Wallet account stats exclusion flag.'],
  ['records', 'id', 'string', 'Record primary key.'],
  ['records', 'recordDate', 'ISO date string', 'Transaction date used for budget month grouping.'],
  ['records', 'recordType', 'string', 'Observed values include expense and income.'],
  ['records', 'recordState', 'string', 'Observed values include cleared and uncleared.'],
  ['records', 'accountId', 'string', 'Account foreign key.'],
  ['records', 'accountName', 'string', 'Account display name snapshot.'],
  ['records', 'category.id', 'string', 'Category foreign key.'],
  ['records', 'category.name', 'string', 'Category display name snapshot.'],
  ['records', 'category.group.id', 'string', 'Category group id snapshot.'],
  ['records', 'category.group.name', 'string', 'Category group display name snapshot.'],
  ['records', 'amount.value', 'number', 'Signed transaction amount in amount.currencyCode. Negative expenses, positive incomes.'],
  ['records', 'amount.currencyCode', 'string', 'Transaction currency; observed EUR and ZAR. No separate converted/reference EUR field observed.'],
  ['records', 'account balance snapshot', 'not exposed', 'Direct REST and CouchDB schema review found no per-transaction account balance field; period closing balances are reconstructed from account balances plus all-time transaction deltas.'],
  ['records', 'note', 'string', 'Transaction note/merchant text.'],
  ['records', 'paymentType', 'string', 'Payment type, for example transfer.'],
  ['records', 'source', 'string', 'Source, for example backend, web, or android.']
];

function setup() {
  initializeSpreadsheet();
  writeDefaultSettings();
  writeBudgetBakersSchemaReference();
  installTriggers();
  if (getWalletToken()) {
    syncWalletData();
  }
  if (getSheet(SHEETS.TRANSACTIONS).getLastRow() > 1) {
    setupFormulaDrivenBudgetSheets();
  }
  logRun('INFO', 'setup', 'Spreadsheet initialized with hardcoded BudgetBakers schema and all-time transaction sync.');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Family Budget')
    .addItem('Sync all Wallet transactions', 'runFullRefresh')
    .addItem('Repair final budget workbook', 'setupFormulaDrivenBudgetSheets')
    .addItem('Debug status', 'debugStatus')
    .addToUi();
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const mode = params['hub.mode'];
  const token = params['hub.verify_token'];
  const challenge = params['hub.challenge'];
  const expectedToken = getWhatsAppWebhookVerifyToken();

  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    logRun('INFO', 'doGet', 'WhatsApp webhook verification succeeded.');
    return ContentService.createTextOutput(challenge || '');
  }

  logRun('WARN', 'doGet', 'WhatsApp webhook verification failed.');
  return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '';
    console.log('doPost webhook received bytes=' + body.length);
    const payload = body ? JSON.parse(body) : {};
    handleWhatsAppWebhookPayload(payload);
    return ContentService.createTextOutput('EVENT_RECEIVED').setMimeType(ContentService.MimeType.TEXT);
  } catch (error) {
    console.error('doPost webhook error: ' + (error.stack || error.message));
    logRun('ERROR', 'doPost', error.stack || error.message);
    return ContentService.createTextOutput('EVENT_RECEIVED').setMimeType(ContentService.MimeType.TEXT);
  }
}

function runFullRefresh() {
  try {
    syncWalletData();
    setupFormulaDrivenBudgetSheets();
    SpreadsheetApp.flush();
    logRun('INFO', 'runFullRefresh', 'Full refresh completed. Wallet data synced and formula-driven budget sheets refreshed.');
  } catch (error) {
    logRun('ERROR', 'runFullRefresh', error.stack || error.message);
    throw error;
  }
}

function runSchemaReview() {
  writeBudgetBakersSchemaReference();
  logRun('INFO', 'runSchemaReview', 'Wrote hardcoded BudgetBakers schema reference. No Wallet API schema sampling was performed.');
}

function buildBudgetOutputsOnly() {
  setupFormulaDrivenBudgetSheets();
  logRun('INFO', 'buildBudgetOutputsOnly', 'Formula-driven Budget, Summary, Accounts, and YesterdayExpenses repaired from existing transactions.');
}

function writeBudgetBakersSchemaReference() {
  const rows = BB_SCHEMA_REFERENCE.map(function (row) {
    return [row[0], row[1], row[2], '', row[3]];
  });
  replaceSheetData(getSheet(SHEETS.SCHEMA_REVIEW), HEADERS.SchemaReview, rows);
}

function runHourlySync() {
  try {
    syncWalletData();
    SpreadsheetApp.flush();
    logRun('INFO', 'runHourlySync', 'Hourly sync completed. Transactions refreshed; sheet formulas drive Budget and Summary.');
  } catch (error) {
    logRun('ERROR', 'runHourlySync', error.stack || error.message);
    throw error;
  }
}

function runDailySummary() {
  try {
    SpreadsheetApp.flush();
    sendWhatsAppDailySummary();
    logRun('INFO', 'runDailySummary', 'Daily WhatsApp summary sent.');
  } catch (error) {
    logRun('ERROR', 'runDailySummary', error.stack || error.message);
    throw error;
  }
}

function debugStatus() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('WALLET_API_TOKEN');
  const ss = getSpreadsheet();
  const status = {
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    scriptProperties: {
      hasWalletApiToken: !!token,
      spreadsheetId: props.getProperty('SPREADSHEET_ID') || '',
      spreadsheetUrl: props.getProperty('SPREADSHEET_URL') || ''
    },
    sheets: {},
    recentRunLog: []
  };
  Object.keys(SHEETS).forEach(function (key) {
    const sheetName = SHEETS[key];
    const sheet = ss.getSheetByName(sheetName);
    status.sheets[sheetName] = sheet ? { lastRow: sheet.getLastRow(), lastColumn: sheet.getLastColumn() } : { missing: true };
  });
  const runLog = ss.getSheetByName(SHEETS.RUN_LOG);
  if (runLog && runLog.getLastRow() > 1) {
    const count = Math.min(runLog.getLastRow() - 1, 10);
    status.recentRunLog = runLog.getRange(runLog.getLastRow() - count + 1, 1, count, Math.min(runLog.getLastColumn(), 4)).getValues().map(function (row) {
      return row.map(function (cell) {
        return cell instanceof Date ? cell.toISOString() : cell;
      });
    });
  }
  console.log(JSON.stringify(status));
  return status;
}

function setScriptPropertiesFromJson(properties) {
  if (typeof properties === 'string') properties = JSON.parse(properties);
  const allowed = [
    'WALLET_API_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_API_VERSION',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    'CLAUDE_API_KEY',
    'CLAUDE_AGENT_ID',
    'CLAUDE_ENV_ID',
    'CLAUDE_VAULT_ID',
    'CLAUDE_VAULT_IDS',
    'CLAUDE_VAULT_CREDENTIAL_ID'
  ];
  const output = {};
  allowed.forEach(function (key) {
    if (properties && properties[key]) output[key] = String(properties[key]);
  });
  PropertiesService.getScriptProperties().setProperties(output, false);
  logRun('INFO', 'setScriptPropertiesFromJson', 'Updated script properties: ' + Object.keys(output).join(', '));
  return { ok: true, keys: Object.keys(output) };
}

function compareScriptPropertiesFromJson(properties) {
  if (typeof properties === 'string') properties = JSON.parse(properties);
  const props = PropertiesService.getScriptProperties().getProperties();
  const expected = properties || {};
  const keys = Object.keys(expected).sort();
  const comparison = keys.map(function (key) {
    const expectedValue = String(expected[key] || '');
    const actualValue = Object.prototype.hasOwnProperty.call(props, key) ? String(props[key] || '') : '';
    return {
      key: key,
      expectedPresent: expectedValue.length > 0,
      actualPresent: actualValue.length > 0,
      matches: expectedValue === actualValue,
      expectedLength: expectedValue.length,
      actualLength: actualValue.length
    };
  });
  const scriptOnlyKeys = Object.keys(props).filter(function (key) {
    return !Object.prototype.hasOwnProperty.call(expected, key);
  }).sort();
  const mismatches = comparison.filter(function (row) { return !row.matches; }).map(function (row) { return row.key; });
  const result = {
    ok: mismatches.length === 0,
    checkedKeys: keys,
    mismatches: mismatches,
    comparison: comparison,
    scriptOnlyKeys: scriptOnlyKeys
  };
  console.log(JSON.stringify(result));
  return result;
}

function setAndCompareScriptPropertiesFromJson(properties) {
  const setResult = setScriptPropertiesFromJson(properties);
  const compareResult = compareScriptPropertiesFromJson(properties);
  return {
    set: setResult,
    compare: compareResult
  };
}

function migrateApiSettingsToScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const existing = sheet ? readKeyValueSheet(sheet) : {};
  const updates = {};

  if (!props.getProperty('SPREADSHEET_ID')) updates.SPREADSHEET_ID = ss.getId();
  if (!props.getProperty('SPREADSHEET_URL')) updates.SPREADSHEET_URL = ss.getUrl();
  if (!props.getProperty('WHATSAPP_API_VERSION')) updates.WHATSAPP_API_VERSION = existing.WHATSAPP_API_VERSION || 'v25.0';
  if (!props.getProperty('WHATSAPP_WEBHOOK_VERIFY_TOKEN')) updates.WHATSAPP_WEBHOOK_VERIFY_TOKEN = existing.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'family-budget-whatsapp-webhook';
  if (Object.keys(updates).length) props.setProperties(updates, false);

  if (sheet) removeSettingsRows(['WHATSAPP_API_VERSION', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']);
  logRun('INFO', 'migrateApiSettingsToScriptProperties', 'Updated script properties and removed API rows from Settings: ' + Object.keys(updates).join(', '));
  return {
    ok: true,
    updatedKeys: Object.keys(updates),
    removedSettingsKeys: ['WHATSAPP_API_VERSION', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN'],
    spreadsheetIdPresent: !!props.getProperty('SPREADSHEET_ID'),
    spreadsheetUrlPresent: !!props.getProperty('SPREADSHEET_URL'),
    whatsappApiVersionPresent: !!props.getProperty('WHATSAPP_API_VERSION'),
    webhookVerifyTokenPresent: !!props.getProperty('WHATSAPP_WEBHOOK_VERIFY_TOKEN')
  };
}

function migrateWhatsAppOnlyFormulaBudget() {
  const ss = getSpreadsheet();
  removeSettingsRows(['EMAIL_TO', 'NTFY_TOPIC', 'ALERT_THRESHOLDS', 'BASELINE_MONTHS']);
  const alertLog = ss.getSheetByName('AlertLog');
  if (alertLog) ss.deleteSheet(alertLog);
  const bbTotals = ss.getSheetByName('BudgetBakersCategoryTotals');
  if (bbTotals) ss.deleteSheet(bbTotals);
  ensureFinalBudgetSheetName();
  ensureSheetColumnCapacity(getSheet(SHEETS.BUDGETS), HEADERS.Budgets.length);
  setupFormulaDrivenBudgetSheets();
  logRun('INFO', 'migrateWhatsAppOnlyFormulaBudget', 'Removed email/ntfy/alert settings and AlertLog sheet; installed formula-driven budget sheets.');
  return {
    ok: true,
    removedSettingsKeys: ['EMAIL_TO', 'NTFY_TOPIC', 'ALERT_THRESHOLDS', 'BASELINE_MONTHS'],
    removedAlertLogSheet: !!alertLog,
    removedBudgetBakersCategoryTotalsSheet: !!bbTotals,
    budgetsColumns: getSheet(SHEETS.BUDGETS).getLastColumn(),
    summaryColumns: getSheet(SHEETS.SUMMARY).getLastColumn()
  };
}

function ensureFinalBudgetSheetName() {
  const ss = getSpreadsheet();
  const finalSheet = ss.getSheetByName(SHEETS.BUDGETS);
  if (finalSheet) return finalSheet;
  const legacySheet = ss.getSheetByName('Budgets');
  if (legacySheet) {
    legacySheet.setName(SHEETS.BUDGETS);
    return legacySheet;
  }
  return ss.insertSheet(SHEETS.BUDGETS);
}

function repairFormulaBudgetSheetsAndStatus() {
  ensureFinalBudgetSheetName();
  ensureSheetColumnCapacity(getSheet(SHEETS.BUDGETS), HEADERS.Budgets.length);
  setupFormulaDrivenBudgetSheets();
  const budgets = getSheet(SHEETS.BUDGETS);
  const summary = getSheet(SHEETS.SUMMARY);
  return {
    ok: true,
    budgetsLastRow: budgets.getLastRow(),
    budgetsLastColumn: budgets.getLastColumn(),
    budgetsMaxColumns: budgets.getMaxColumns(),
    budgetsHeaders: budgets.getRange(1, 1, 1, budgets.getLastColumn()).getValues()[0],
    totalRow: budgets.getRange(2, 1, 1, Math.min(budgets.getLastColumn(), HEADERS.Budgets.length)).getDisplayValues()[0],
    totalFormulas: budgets.getRange(2, 8, 1, 10).getFormulas()[0],
    summaryLastRow: summary.getLastRow(),
    summaryLastColumn: summary.getLastColumn(),
    summaryFormula: summary.getRange('A2').getFormula()
  };
}

function resetBudgetSelectionsToDefaults() {
  ensureFinalBudgetSheetName();
  ensureSheetColumnCapacity(getSheet(SHEETS.BUDGETS), HEADERS.Budgets.length);
  setupFormulaDrivenBudgetSheets();
  const sheet = getSheet(SHEETS.BUDGETS);
  const rows = readObjects(SHEETS.BUDGETS);
  if (!rows.length) {
    setupFormulaDrivenBudgetSheets();
    return { ok: true, updatedRows: 0, note: 'Budget sheet had no rows; rebuilt from categories.' };
  }
  const periodValues = [];
  const forecastTypeValues = [];
  const budgetValues = [];
  const reportValues = [];
  const expenseValues = [];
  rows.forEach(function (row) {
    const defaults = getBudgetDefaultSelection(row.RowType, row.CategoryType, row.Category);
    periodValues.push([defaults.period]);
    forecastTypeValues.push([defaults.forecastType]);
    budgetValues.push([defaults.budgetEUR]);
    reportValues.push([defaults.report]);
    expenseValues.push([defaults.expense]);
  });
  sheet.getRange(2, 2, rows.length, 1).setValues(periodValues);
  sheet.getRange(2, 3, rows.length, 1).setValues(forecastTypeValues);
  sheet.getRange(2, 4, rows.length, 1).setValues(budgetValues);
  sheet.getRange(2, 5, rows.length, 1).setValues(reportValues);
  sheet.getRange(2, 6, rows.length, 1).setValues(expenseValues);
  setupFormulaDrivenBudgetSheets();
  return { ok: true, updatedRows: rows.length, budgetEURSetFromDefaults: true };
}

function verifyFinalWorkbookLayout() {
  const ss = getSpreadsheet();
  const budget = getSheet(SHEETS.BUDGETS);
  const summary = getSheet(SHEETS.SUMMARY);
  const accounts = getSheet(SHEETS.ACCOUNTS);
  const settings = getSheet(SHEETS.SETTINGS);
  const settingValues = readKeyValueSheet(settings);
  const result = {
    removedSheets: {
      Dashboard: !ss.getSheetByName('Dashboard'),
      AlertLog: !ss.getSheetByName('AlertLog'),
      BudgetBakersCategoryTotals: !ss.getSheetByName('BudgetBakersCategoryTotals')
    },
    budget: {
      lastRow: budget.getLastRow(),
      lastColumn: budget.getLastColumn(),
      hiddenHelperColumns16To22: [16, 17, 18, 19, 20, 21, 22].every(function (column) { return budget.isColumnHiddenByUser(column); }),
      hasFilter: !!budget.getFilter(),
      frozenRows: budget.getFrozenRows(),
      periodValidationValues: budget.getRange(2, 2).getDataValidation() ? budget.getRange(2, 2).getDataValidation().getCriteriaValues()[0] : [],
      forecastTypeValidationValues: budget.getRange(2, 3).getDataValidation() ? budget.getRange(2, 3).getDataValidation().getCriteriaValues()[0] : [],
      typeRows: budget.getRange(2, 21, Math.max(budget.getLastRow() - 1, 1), 1).getValues().filter(function (row) { return row[0] === 'TYPE'; }).length,
      firstRows: budget.getRange(1, 1, Math.min(budget.getLastRow(), 8), 15).getDisplayValues()
    },
    summary: {
      lastRow: summary.getLastRow(),
      lastColumn: summary.getLastColumn(),
      hasFilter: !!summary.getFilter(),
      frozenRows: summary.getFrozenRows(),
      header: summary.getRange(1, 1, 1, summary.getLastColumn()).getDisplayValues()[0],
      overallRow: summary.getRange(2, 1, 1, summary.getLastColumn()).getDisplayValues()[0]
    },
    accounts: {
      lastRow: accounts.getLastRow(),
      lastColumn: accounts.getLastColumn(),
      hiddenAccountIdColumn7: accounts.isColumnHiddenByUser(7),
      hasFilter: !!accounts.getFilter(),
      header: accounts.getRange(1, 1, 1, accounts.getLastColumn()).getDisplayValues()[0]
    },
    settings: {
      budgetMonthStartDay: settingValues.BUDGET_MONTH_START_DAY || CONFIG_DEFAULTS.BUDGET_MONTH_START_DAY,
      hasFilter: !!settings.getFilter(),
      lastRow: settings.getLastRow()
    }
  };
  console.log(JSON.stringify(result));
  return result;
}

function devRebuildAndStatus() {
  buildBudgetOutputsOnly();
  const budgets = readObjects(SHEETS.BUDGETS);
  const summary = readObjects(SHEETS.SUMMARY);
  const nonZeroBudgets = budgets.filter(function (row) { return parseSheetNumber(row.BudgetEUR) > 0; }).length;
  const reportedBudgets = budgets.filter(function (row) { return String(row.Report).toUpperCase() === 'TRUE'; }).length;
  const nonZeroSummarySpend = summary.filter(function (row) { return parseSheetNumber(row.SpentEUR) > 0; }).length;
  const status = {
    budgets: {
      rows: budgets.length,
      nonZeroBudgetRows: nonZeroBudgets,
      reportedRows: reportedBudgets,
      top: budgets.slice(0, 10).map(function (row) {
        return {
          category: row.Category,
          budgetEUR: parseSheetNumber(row.BudgetEUR),
          report: String(row.Report)
        };
      })
    },
    summary: {
      rows: summary.length,
      nonZeroSpendRows: nonZeroSummarySpend,
      top: summary.slice(0, 10).map(function (row) {
        return {
          category: row.Category,
          budgetEUR: parseSheetNumber(row.BudgetEUR),
          spentEUR: parseSheetNumber(row.SpentEUR),
          forecastEUR: parseSheetNumber(row.ForecastEUR),
          status: row.Status
        };
      })
    }
  };
  console.log(JSON.stringify(status));
  return status;
}

function devRebuildAndStatusJson() {
  return JSON.stringify(devRebuildAndStatus(), null, 2);
}

function devCurrentStatusJson() {
  const budgets = readObjects(SHEETS.BUDGETS);
  const summary = readObjects(SHEETS.SUMMARY);
  const transactions = readObjects(SHEETS.TRANSACTIONS);
  const status = {
    transactions: {
      rows: transactions.length,
      expenseRows: transactions.filter(function (row) { return String(row.Type).trim().toLowerCase() === 'expense'; }).length,
      incomeRows: transactions.filter(function (row) { return String(row.Type).trim().toLowerCase() === 'income'; }).length
    },
    budgets: {
      rows: budgets.length,
      nonZeroBudgetRows: budgets.filter(function (row) { return parseSheetNumber(row.BudgetEUR) > 0; }).length,
      reportedRows: budgets.filter(function (row) { return String(row.Report).toUpperCase() === 'TRUE'; }).length,
      top: budgets.slice(0, 10).map(function (row) {
        return {
          category: row.Category,
          budgetEUR: parseSheetNumber(row.BudgetEUR),
          report: String(row.Report)
        };
      })
    },
    summary: {
      rows: summary.length,
      nonZeroSpendRows: summary.filter(function (row) { return parseSheetNumber(row.SpentEUR) > 0; }).length,
      top: summary.slice(0, 10).map(function (row) {
        return {
          category: row.Category,
          budgetEUR: parseSheetNumber(row.BudgetEUR),
          spentEUR: parseSheetNumber(row.SpentEUR),
          forecastEUR: parseSheetNumber(row.ForecastEUR),
          status: row.Status
        };
      })
    }
  };
  console.log(JSON.stringify(status));
  return JSON.stringify(status, null, 2);
}

function devClaudeContextStatusJson() {
  const context = buildClaudeBudgetContext();
  const status = {
    hasBudgetNote: !!context.budgetNote,
    transactionCount: context.transactions.length,
    summaryCount: context.summary.length,
    manualBudgetCount: context.manualBudgets.length,
    allBudgetsSheetRows: readObjects(SHEETS.BUDGETS).length,
    firstManualBudgetKeys: context.manualBudgets.length ? Object.keys(context.manualBudgets[0]) : [],
    manualBudgetRowsWithBudgetEUR: context.manualBudgets.filter(function (row) { return row.budgetEUR > 0; }).length,
    manualBudgetRowsEnabled: context.manualBudgets.filter(function (row) { return row.enabled; }).length,
    manualBudgetRowsReported: context.manualBudgets.filter(function (row) { return row.report; }).length
  };
  console.log(JSON.stringify(status));
  return JSON.stringify(status, null, 2);
}

function devRecentWhatsAppStatusJson() {
  const messageRows = readObjects(SHEETS.MESSAGE_LOG).slice(-10).map(function (row) {
    return {
      timestamp: row.Timestamp instanceof Date ? row.Timestamp.toISOString() : row.Timestamp,
      messageId: row.MessageId,
      from: row.From,
      inboundTimestamp: row.InboundTimestamp instanceof Date ? row.InboundTimestamp.toISOString() : row.InboundTimestamp,
      textPreview: String(row.Text || '').slice(0, 120),
      status: row.Status,
      errorCode: row.ErrorCode,
      errorMessagePreview: String(row.ErrorMessage || '').slice(0, 800),
      claudeSessionId: row.ClaudeSessionId,
      claudeEventSummary: row.ClaudeEventSummary,
      contextBytes: row.ContextBytes,
      transactionCount: row.TransactionCount,
      outboundAt: row.OutboundAt instanceof Date ? row.OutboundAt.toISOString() : row.OutboundAt,
      outboundMessageId: row.OutboundMessageId,
      notes: String(row.Notes || '').slice(0, 500)
    };
  });
  const runRows = readObjects(SHEETS.RUN_LOG).slice(-20).map(function (row) {
    return {
      timestamp: row.Timestamp instanceof Date ? row.Timestamp.toISOString() : row.Timestamp,
      level: row.Level,
      action: row.Action,
      messagePreview: String(row.Message || '').slice(0, 1000)
    };
  });
  const status = {
    checkedAt: new Date().toISOString(),
    messageLogRows: messageRows.length,
    recentMessages: messageRows,
    recentRunLog: runRows
  };
  console.log(JSON.stringify(status));
  return JSON.stringify(status, null, 2);
}

function initializeSpreadsheet() {
  const ss = getSpreadsheet();
  Object.keys(SHEETS).forEach(function (key) {
    const sheetName = SHEETS[key];
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    const headers = HEADERS[sheetName];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
      sheet.setFrozenRows(1);
    }
  });
  const dashboard = ss.getSheetByName('Dashboard');
  if (dashboard) ss.deleteSheet(dashboard);
}

function getMessageLogSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.MESSAGE_LOG);
  if (!sheet) sheet = ss.insertSheet(SHEETS.MESSAGE_LOG);
  const headers = HEADERS.MessageLog;
  if (sheet.getLastRow() < 1 || sheet.getRange(1, 1, 1, headers.length).getValues()[0].join('|') !== headers.join('|')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function beginMessageProcessing(message, text) {
  const messageId = getWhatsAppMessageId(message);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'wa_msg_' + messageId;
    if (cache.get(cacheKey)) return { messageId: messageId, duplicate: true };

    const existingRow = findMessageLogRow(messageId);
    if (existingRow) {
      cache.put(cacheKey, '1', 21600);
      updateMessageLog(messageId, { Notes: appendLogNote(readMessageLogValue(existingRow, 'Notes'), 'Duplicate webhook ignored at ' + new Date().toISOString()) });
      return { messageId: messageId, duplicate: true };
    }

    const inboundTimestamp = getWhatsAppInboundDate(message);
    getMessageLogSheet().appendRow([
      new Date(),
      messageId,
      maskPhoneForLog(message.from),
      inboundTimestamp,
      String(text || '').slice(0, 4000),
      'PROCESSING',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ]);
    cache.put(cacheKey, '1', 21600);
    return { messageId: messageId, duplicate: false };
  } finally {
    lock.releaseLock();
  }
}

function getWhatsAppMessageId(message) {
  if (message && message.id) return String(message.id);
  const raw = [message && message.from || '', message && message.timestamp || '', message && message.type || '', JSON.stringify(message || {}).slice(0, 500)].join('|');
  return 'generated_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)).slice(0, 40);
}

function getWhatsAppInboundDate(message) {
  const ts = Number(message && message.timestamp ? message.timestamp : 0);
  return ts ? new Date(ts * 1000) : new Date();
}

function findMessageLogRow(messageId) {
  const sheet = getMessageLogSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const found = sheet.getRange(2, 2, lastRow - 1, 1).createTextFinder(String(messageId)).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function readMessageLogValue(row, header) {
  const sheet = getMessageLogSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const index = headers.indexOf(header);
  if (index < 0 || row < 2) return '';
  return sheet.getRange(row, index + 1).getValue();
}

function updateMessageLog(messageId, fields) {
  try {
    const sheet = getMessageLogSheet();
    const row = findMessageLogRow(messageId);
    if (!row) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Object.keys(fields || {}).forEach(function (key) {
      const col = headers.indexOf(key) + 1;
      if (col <= 0) return;
      let value = fields[key];
      if (value && typeof value === 'object' && !(value instanceof Date)) value = JSON.stringify(value);
      if (typeof value === 'string' && value.length > 45000) value = value.slice(0, 45000);
      sheet.getRange(row, col).setValue(value);
    });
  } catch (error) {
    console.error('updateMessageLog failed: ' + (error.stack || error.message));
  }
}

function assertMessageStillSendable(messageId, config) {
  const row = findMessageLogRow(messageId);
  if (!row) return false;
  const status = String(readMessageLogValue(row, 'Status') || '');
  if (status !== 'PROCESSING') return false;
  return isInboundWithinStaleWindow(messageId, config);
}

function isInboundWithinStaleWindow(messageId, config) {
  const row = findMessageLogRow(messageId);
  if (!row) return false;
  const inbound = readMessageLogValue(row, 'InboundTimestamp');
  const inboundMs = inbound instanceof Date ? inbound.getTime() : new Date(inbound).getTime();
  const maxAgeMs = Number((config || getConfig()).WHATSAPP_MESSAGE_STALE_SECONDS || CONFIG_DEFAULTS.WHATSAPP_MESSAGE_STALE_SECONDS) * 1000;
  if (!inboundMs || isNaN(inboundMs)) return false;
  return Date.now() - inboundMs <= maxAgeMs;
}

function appendLogNote(existing, note) {
  return [String(existing || '').trim(), note].filter(Boolean).join('\n').slice(0, 45000);
}

function writeDefaultSettings() {
  const sheet = getSheet(SHEETS.SETTINGS);
  const existing = readKeyValueSheet(sheet);
  const rows = Object.keys(CONFIG_DEFAULTS).map(function (key) {
    return [key, existing[key] || CONFIG_DEFAULTS[key], settingNote(key)];
  });
  rows.push(['WALLET_API_TOKEN', 'DO_NOT_PUT_TOKEN_HERE', 'Store this in Apps Script Project Settings > Script Properties, not in the sheet.']);
  replaceSheetData(sheet, HEADERS.Settings, rows);
  applySettingsFormatting(sheet);
}

function applySettingsFormatting(sheet) {
  const rowCount = Math.max(sheet.getLastRow() - 1, 1);
  sheet.getRange(1, 1, 1, HEADERS.Settings.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#444444');
  sheet.getRange(2, 1, rowCount, HEADERS.Settings.length).setBackground('#ffffff');
  const values = sheet.getRange(2, 1, rowCount, 1).getValues();
  values.forEach(function (row, index) {
    if (String(row[0] || '') !== 'BUDGET_MONTH_START_DAY') return;
    const target = sheet.getRange(index + 2, 2);
    const rule = SpreadsheetApp.newDataValidation().requireNumberBetween(1, 31).setAllowInvalid(false).build();
    target.setDataValidation(rule).setNumberFormat('0');
    sheet.getRange(index + 2, 1, 1, HEADERS.Settings.length).setBackground('#fff2cc');
  });
  recreateFilter(sheet, HEADERS.Settings.length);
  sheet.autoResizeColumns(1, HEADERS.Settings.length);
}

function removeSettingsRows(keys) {
  const remove = {};
  (keys || []).forEach(function (key) { remove[key] = true; });
  const sheet = getSheet(SHEETS.SETTINGS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  for (let row = values.length; row >= 2; row--) {
    const key = String(values[row - 1][0] || '');
    if (remove[key]) sheet.deleteRow(row);
  }
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const fn = trigger.getHandlerFunction();
    if (fn === 'runHourlySync' || fn === 'runDailySummary' || fn === 'captureBudgetPeriodClosingBalances') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runHourlySync').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('runDailySummary').timeBased().atHour(Number(getConfig().SUMMARY_HOUR || 9)).everyDays(1).create();
  ScriptApp.newTrigger('captureBudgetPeriodClosingBalances').timeBased().onMonthDay(24).atHour(Number(getConfig().CASHFLOW_CAPTURE_HOUR || 22)).create();
}

function syncWalletData() {
  const config = getConfig();
  assertWalletToken();

  const categories = fetchWalletCategories();
  const accounts = fetchWalletAccounts();
  const categoryMap = buildCategoryMap(categories);
  const accountMap = buildAccountMap(accounts);

  writeCategoriesSheet(categories, categoryMap);
  writeAccountsSheet(accounts);

  const records = fetchWalletRecords();
  logRun('INFO', 'syncWalletData', 'Normalizing ' + records.length + ' record(s).');
  const normalized = normalizeRecords(records, categoryMap, accountMap, config);
  logRun('INFO', 'syncWalletData', 'Writing ' + normalized.length + ' normalized transaction row(s).');
  writeTransactionsSheet(normalized);
  logRun('INFO', 'syncWalletData', 'Synced ' + categories.length + ' categories, ' + accounts.length + ' accounts, ' + normalized.length + ' records.');
}

function fetchWalletCategories() {
  return fetchAllPages('/v1/api/categories', {});
}

function fetchWalletAccounts() {
  return fetchAllPages('/v1/api/accounts', {});
}

function fetchWalletRecords() {
  const records = [];
  let offset = 0;
  let nextOffset = 0;
  let pages = 0;
  const maxPages = 200;
  const seenOffsets = {};

  while (nextOffset !== null && nextOffset !== undefined && nextOffset !== '' && pages < maxPages) {
    if (seenOffsets[String(offset)]) break;
    seenOffsets[String(offset)] = true;

    const response = walletFetch('/v1/api/records', { limit: 200, offset: offset });
    const items = Array.isArray(response) ? response : (response.items || response.data || response.records || []);
    if (!items.length) break;

    items.forEach(function (record) {
      records.push(record);
    });

    pages += 1;
    nextOffset = response && response.nextOffset !== undefined ? response.nextOffset : null;
    if (nextOffset === offset) break;
    offset = nextOffset;
  }

  logRun('INFO', 'fetchWalletRecords', 'Fetched ' + records.length + ' raw all-time record rows across ' + pages + ' page(s).');
  return records;
}

function fetchAllPages(endpoint, params) {
  const results = [];
  let offset = 0;
  let nextOffset = 0;
  const seenOffsets = {};
  do {
    if (seenOffsets[String(offset)]) break;
    seenOffsets[String(offset)] = true;

    const pageParams = Object.assign({}, params || {}, { limit: params.limit || 200, offset: offset });
    const response = walletFetch(endpoint, pageParams);
    const items = Array.isArray(response) ? response : (response.items || response.data || response.records || response.categories || response.accounts || []);
    items.forEach(function (item) { results.push(item); });
    nextOffset = response && response.nextOffset !== undefined ? response.nextOffset : null;
    if (nextOffset === offset) break;
    offset = nextOffset;
  } while (nextOffset !== null && nextOffset !== undefined && nextOffset !== '');
  return results;
}

function walletFetch(endpoint, params) {
  const config = getConfig();
  const token = getWalletToken();
  const url = buildUrl(config.WALLET_API_BASE_URL + endpoint, params);
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    }
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code === 401 || code === 403) throw codedError(ERROR_CODES.WALLET_AUTH, 'Wallet API authentication/permission failed: HTTP ' + code, { endpoint: endpoint, status: code, body: body.slice(0, 1000) });
  if (code === 409) throw codedError(ERROR_CODES.WALLET_API, 'Wallet sync is still in progress. Try again later.', { endpoint: endpoint, status: code, body: body.slice(0, 1000) });
  if (code < 200 || code >= 300) throw codedError(ERROR_CODES.WALLET_API, 'Wallet API failed: HTTP ' + code, { endpoint: endpoint, status: code, body: body.slice(0, 1000) });
  return body ? JSON.parse(body) : {};
}

function testWalletAuth() {
  const started = new Date();
  const endpoint = '/v1/api/api-usage/stats';
  try {
    assertWalletToken();
    const result = walletFetch(endpoint, { period: '30days' });
    const status = {
      ok: true,
      endpoint: endpoint,
      period: '30days',
      checkedAt: started.toISOString(),
      responseKeys: Object.keys(result || {})
    };
    logRun('INFO', 'testWalletAuth', JSON.stringify(status));
    return status;
  } catch (error) {
    const coded = normalizeError(error, ERROR_CODES.WALLET_API);
    const status = {
      ok: false,
      endpoint: endpoint,
      period: '30days',
      checkedAt: started.toISOString(),
      code: coded.code,
      message: coded.message,
      details: coded.details || {}
    };
    logRun('ERROR', 'testWalletAuth', JSON.stringify(status).slice(0, 4000));
    return status;
  }
}

function calculateBudgetTargetsFromMayJune() {
  setupFormulaDrivenBudgetSheets();
}

function calculateBudgetSummary() {
  setupFormulaDrivenSummarySheet();
}

function setupFormulaDrivenBudgetSheets() {
  writeDefaultSettings();
  setupFormulaDrivenBudgetsSheet();
  setupFormulaDrivenSummarySheet();
  setupCashFlowPeriodBalancesSheet();
  setupYesterdayExpensesSheet();
  removeLegacyDashboardSheet();
  SpreadsheetApp.flush();
  logRun('INFO', 'setupFormulaDrivenBudgetSheets', 'Formula-driven Budget, Summary, and YesterdayExpenses sheets are ready.');
}

function setupFormulaDrivenBudgetsSheet() {
  const categories = readObjects(SHEETS.CATEGORIES);
  const existing = readObjects(SHEETS.BUDGETS).reduce(function (map, row) {
    const key = row.CategoryId || row.Path || row.Category;
    if (key) map[key] = row;
    return map;
  }, {});
  const nodes = buildBudgetHierarchyRows(categories);
  const typeRowRange = nodes.reduce(function (range, node, index) {
    if (node.rowType !== 'TYPE') return range;
    const rowNumber = index + 2;
    if (!range) return { start: rowNumber, end: rowNumber };
    range.start = Math.min(range.start, rowNumber);
    range.end = Math.max(range.end, rowNumber);
    return range;
  }, null);
  const typeChildRanges = nodes.reduce(function (map, node, index) {
    if (node.rowType !== 'CATEGORY') return map;
    const rowNumber = index + 2;
    if (!map[node.categoryType]) map[node.categoryType] = { start: rowNumber, end: rowNumber };
    map[node.categoryType].start = Math.min(map[node.categoryType].start, rowNumber);
    map[node.categoryType].end = Math.max(map[node.categoryType].end, rowNumber);
    return map;
  }, {});
  const rows = nodes.map(function (node, index) {
    const rowNumber = index + 2;
    const childRange = typeChildRanges[node.categoryType];
    const saved = existing[node.categoryId] || existing[node.path] || existing[node.category] || {};
    const defaults = getBudgetDefaultSelection(node.rowType, node.categoryType, node.display);
    const period = saved.Period || defaults.period;
    const savedForecastType = String(saved['Forecast Type'] || saved['Expense Type'] || '').trim();
    const forecastType = /recurring/i.test(savedForecastType) ? 'Recurring Expense' : (/day/i.test(savedForecastType) ? 'Day-to-day' : defaults.forecastType);
    const savedBudget = saved.BudgetEUR !== undefined && saved.BudgetEUR !== null ? String(saved.BudgetEUR).trim() : '';
    const budget = node.rowType === 'OVERALL' ? '=' + formulaOverallColumnRollupExpression('D', typeRowRange) : (node.rowType === 'TYPE' ? '=' + formulaTypeColumnRollupExpression(rowNumber, 'D', childRange) : (savedBudget !== '' ? savedBudget : defaults.budgetEUR));
    const report = saved['Include in Report?'] !== undefined && saved['Include in Report?'] !== '' ? saved['Include in Report?'] : defaults.report;
    const expense = saved['Include in Expense Calculations'] !== undefined && saved['Include in Expense Calculations'] !== '' ? saved['Include in Expense Calculations'] : defaults.expense;
    return [
      node.display,
      period,
      forecastType,
      budget,
      report,
      expense,
      formulaBudgetRollup(rowNumber, 0, 'G', childRange, typeRowRange),
      '=ROUND(D' + rowNumber + '-G' + rowNumber + ',2)',
      '=IF(D' + rowNumber + '>0,G' + rowNumber + '/D' + rowNumber + ',0)',
      formulaForecast(rowNumber, childRange, typeRowRange),
      '=ROUND(J' + rowNumber + '-D' + rowNumber + ',2)',
      formulaBudgetRollup(rowNumber, -1, 'L', childRange, typeRowRange),
      formulaBudgetRollup(rowNumber, -2, 'M', childRange, typeRowRange),
      formulaBudgetRollup(rowNumber, -3, 'N', childRange, typeRowRange),
      '=ROUND(AVERAGE(L' + rowNumber + ':N' + rowNumber + '),2)',
      node.categoryId,
      node.parentId,
      node.categoryType,
      node.depth,
      node.path,
      node.rowType,
      '=AND(UPPER(TO_TEXT(F' + rowNumber + '))="TRUE",$U' + rowNumber + '<>"TYPE",$U' + rowNumber + '<>"OVERALL")'
    ];
  });

  const sheet = getSheet(SHEETS.BUDGETS);
  replaceSheetData(sheet, HEADERS.Budgets, rows);
  applyBudgetFormatting(sheet, rows.length);
}

function formulaBudgetRollup(rowNumber, monthOffset, outputColumn, childRange, typeRowRange) {
  return '=IF($U' + rowNumber + '="OVERALL",' + formulaOverallColumnRollupExpression(outputColumn, typeRowRange) + ',IF($U' + rowNumber + '="TYPE",' + formulaTypeColumnRollupExpression(rowNumber, outputColumn, childRange) + ',LET(' + budgetPeriodLetBindings(monthOffset) + ',ROUND(SUMIFS(Transactions!$I:$I,Transactions!$H:$H,"Expense",Transactions!$B:$B,">="&TEXT(periodStart,"yyyy-mm-dd"),Transactions!$B:$B,"<"&TEXT(periodEnd,"yyyy-mm-dd"),Transactions!$G:$G,$T' + rowNumber + '),2))))';
}

function formulaForecast(rowNumber, childRange, typeRowRange) {
  return '=IF($U' + rowNumber + '="OVERALL",' + formulaOverallColumnRollupExpression('J', typeRowRange) + ',IF($U' + rowNumber + '="TYPE",' + formulaTypeColumnRollupExpression(rowNumber, 'J', childRange, false) + ',IF(REGEXMATCH(UPPER(TO_TEXT($C' + rowNumber + ')),"RECUR"),ROUND(D' + rowNumber + ',2),LET(' + budgetPeriodLetBindings(0) + ',periodDays,periodEnd-periodStart,elapsedDays,MAX(1,MIN(TODAY(),periodEnd-1)-periodStart+1),ROUND(IF(periodDays>0,G' + rowNumber + '/elapsedDays*periodDays,G' + rowNumber + '),2)))))';
}

function budgetMonthStartDaySettingFormula() {
  return 'MAX(1,MIN(31,IFERROR(VALUE(VLOOKUP("BUDGET_MONTH_START_DAY",Settings!$A:$B,2,FALSE)),25)))';
}

function budgetPeriodLetBindings(monthOffset) {
  return 'startDay,' + budgetMonthStartDaySettingFormula() + ',anchor,EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),IF(DAY(TODAY())<startDay,-1,0)),periodMonth,EDATE(anchor,' + monthOffset + '),nextPeriodMonth,EDATE(anchor,' + (monthOffset + 1) + '),periodStart,DATE(YEAR(periodMonth),MONTH(periodMonth),MIN(startDay,DAY(EOMONTH(periodMonth,0)))),periodEnd,DATE(YEAR(nextPeriodMonth),MONTH(nextPeriodMonth),MIN(startDay,DAY(EOMONTH(nextPeriodMonth,0))))';
}

function formulaTypeColumnRollup(rowNumber, columnLetter, childRange) {
  return '=' + formulaTypeColumnRollupExpression(rowNumber, columnLetter, childRange);
}

function formulaTypeColumnRollupExpression(rowNumber, columnLetter, childRange, requireExpenseCalculation) {
  if (!childRange) return '0';
  if (requireExpenseCalculation === false) {
    return 'ROUND(IFERROR(SUM($' + columnLetter + '$' + childRange.start + ':$' + columnLetter + '$' + childRange.end + '),0),2)';
  }
  return 'ROUND(IFERROR(SUM(FILTER($' + columnLetter + '$' + childRange.start + ':$' + columnLetter + '$' + childRange.end + ',UPPER(TO_TEXT($F$' + childRange.start + ':$F$' + childRange.end + '))="TRUE")),0),2)';
}

function formulaOverallColumnRollupExpression(columnLetter, typeRowRange) {
  if (!typeRowRange) return '0';
  return 'ROUND(IFERROR(SUM(FILTER($' + columnLetter + '$' + typeRowRange.start + ':$' + columnLetter + '$' + typeRowRange.end + ',UPPER(TO_TEXT($F$' + typeRowRange.start + ':$F$' + typeRowRange.end + '))="TRUE",$U$' + typeRowRange.start + ':$U$' + typeRowRange.end + '="TYPE")),0),2)';
}

function setupFormulaDrivenSummarySheet() {
  const sheet = getSheet(SHEETS.SUMMARY);
  sheet.clearContents();
  sheet.clearFormats();
  sheet.getRange(1, 1, 1, HEADERS.Summary.length).setValues([HEADERS.Summary]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#444444');
  sheet.getRange('A2').setValue('Overall Budget');
  sheet.getRange('B2').setFormula('=ROUND(IFERROR(INDEX(FILTER(Budget!D2:D,Budget!U2:U="OVERALL"),1),0),2)');
  sheet.getRange('C2').setFormula('=ROUND(IFERROR(INDEX(FILTER(Budget!G2:G,Budget!U2:U="OVERALL"),1),0),2)');
  sheet.getRange('D2').setFormula('=ROUND(B2-C2,2)');
  sheet.getRange('E2').setFormula('=IF(B2>0,C2/B2,0)');
  sheet.getRange('F2').setFormula('=ROUND(IFERROR(INDEX(FILTER(Budget!J2:J,Budget!U2:U="OVERALL"),1),0),2)');
  sheet.getRange('G2').setFormula('=ROUND(F2-B2,2)');
  sheet.getRange('A3').setFormula('=FILTER({Budget!A2:A,Budget!D2:D,Budget!G2:G,Budget!H2:H,Budget!I2:I,Budget!J2:J,Budget!K2:K},UPPER(TO_TEXT(Budget!E2:E))="TRUE",Budget!U2:U<>"OVERALL")');
  sheet.setFrozenRows(1);
  recreateFilter(sheet, HEADERS.Summary.length);
  formatMoneyColumns(sheet, [2, 3, 4, 6, 7]);
  sheet.getRange(2, 5, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('0.0%');
  applySummaryForecastColorRules(sheet);
  sheet.autoResizeColumns(1, HEADERS.Summary.length);
}

function applySummaryForecastColorRules(sheet) {
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const forecastRange = sheet.getRange(2, 6, rows, 1);
  const rules = sheet.getConditionalFormatRules().filter(function (rule) {
    return !rule.getRanges().some(function (range) {
      return range.getColumn() === 6 && range.getNumColumns() === 1;
    });
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$F2>$B2')
    .setFontColor('#d93025')
    .setRanges([forecastRange])
    .build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$F2<=$B2')
    .setFontColor('#188038')
    .setRanges([forecastRange])
    .build());
  sheet.setConditionalFormatRules(rules);
}

function setupYesterdayExpensesSheet() {
  const config = getConfig();
  const ss = getSpreadsheet();
  if (!ss.getSheetByName(SHEETS.YESTERDAY_EXPENSES)) ss.insertSheet(SHEETS.YESTERDAY_EXPENSES);
  const includeByPath = readObjects(SHEETS.BUDGETS).reduce(function (map, row) {
    if (String(row['Include in Expense Calculations']).toUpperCase() === 'TRUE') {
      if (row.Path) map[String(row.Path)] = true;
      if (row.CategoryType) map[String(row.CategoryType)] = true;
    }
    return map;
  }, {});
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayText = Utilities.formatDate(yesterday, config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE, 'yyyy-MM-dd');
  const rows = readObjects(SHEETS.TRANSACTIONS).filter(function (row) {
    if (sheetDateText(row.Date) !== yesterdayText) return false;
    if (String(row.Type).toLowerCase() !== 'expense') return false;
    const category = String(row.Category || '');
    const categoryType = String(row.CategoryType || category.split(' > ')[0] || '');
    return !Object.keys(includeByPath).length || includeByPath[category] || includeByPath[categoryType];
  }).map(function (row) {
    return [sheetDateText(row.Date), row.Account, row.Category, row.AmountEUR, row.Note, row.RecordId];
  }).sort(function (a, b) { return String(a[2]).localeCompare(String(b[2])); });
  const sheet = getSheet(SHEETS.YESTERDAY_EXPENSES);
  replaceSheetData(sheet, HEADERS.YesterdayExpenses, rows);
  formatMoneyColumns(sheet, [4]);
}

function setupCashFlowPeriodBalancesSheet() {
  const ss = getSpreadsheet();
  if (!ss.getSheetByName(SHEETS.CASH_FLOW_BALANCES)) ss.insertSheet(SHEETS.CASH_FLOW_BALANCES);
  const sheet = getSheet(SHEETS.CASH_FLOW_BALANCES);
  const existingRows = readObjects(SHEETS.CASH_FLOW_BALANCES);
  const rows = mergeCashFlowBalanceRows(getHardcodedCashFlowClosingBalanceRows().concat(existingRowsToCashFlowRows(existingRows)));
  replaceSheetData(sheet, HEADERS.CashFlowPeriodBalances, rows);
  formatMoneyColumns(sheet, [9, 10]);
}

function captureBudgetPeriodClosingBalances() {
  syncWalletData();
  const config = getConfig();
  const period = getCurrentBudgetPeriod(config);
  const capturedAt = Utilities.formatDate(new Date(), config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const accounts = getNonCashAccountsForCashFlow();
  const existingRows = readObjects(SHEETS.CASH_FLOW_BALANCES);
  const rows = existingRowsToCashFlowRows(existingRows).filter(function (row) {
    return !(row[1] === period.endText && (row[10] === 'Auto-captured Wallet account balance' || row[10] === 'Auto-captured Wallet total'));
  });
  const accountRows = accounts.map(function (account) {
    const currency = String(account.Currency || CONFIG_DEFAULTS.CURRENCY || 'EUR').toUpperCase();
    const balance = parseSheetNumber(account.Balance);
    return buildCashFlowRow(period, capturedAt, 'ACCOUNT', account.Name, account.AccountId, currency, balance, convertAmountToEur(balance, currency, config), 'Auto-captured Wallet account balance', 'Captured monthly on the 24th at 22:00 script timezone.');
  });
  const totalEur = accountRows.reduce(function (sum, row) { return sum + parseSheetNumber(row[9]); }, 0);
  rows.push(buildCashFlowRow(period, capturedAt, 'TOTAL', 'All non-cash accounts', '', 'EUR', totalEur, totalEur, 'Auto-captured Wallet total', 'Total of captured non-cash Wallet balances.'));
  accountRows.forEach(function (row) { rows.push(row); });
  replaceSheetData(getSheet(SHEETS.CASH_FLOW_BALANCES), HEADERS.CashFlowPeriodBalances, mergeCashFlowBalanceRows(getHardcodedCashFlowClosingBalanceRows().concat(rows)));
  formatMoneyColumns(getSheet(SHEETS.CASH_FLOW_BALANCES), [9, 10]);
  logRun('INFO', 'captureBudgetPeriodClosingBalances', 'Captured closing balances for ' + period.display + ' at ' + capturedAt + '.');
}

function sendWhatsAppDailySummary() {
  const config = getConfig();
  if (String(config.WHATSAPP_ENABLED).toUpperCase() !== 'TRUE') {
    logRun('INFO', 'sendWhatsAppDailySummary', 'Skipped because WHATSAPP_ENABLED is not TRUE.');
    return;
  }

  const recipients = getWhatsAppRecipients(config);
  if (!recipients.length) throw new Error('WHATSAPP_TO_NUMBERS is empty. Add comma-separated E.164 numbers, e.g. +23057937859,+353...');

  const message = buildWhatsAppSummaryMessage(readObjects(SHEETS.SUMMARY), config);
  recipients.forEach(function (recipient) {
    const outbound = sendWhatsAppTextMessage(recipient, message, config);
    logRun('INFO', 'sendWhatsAppDailySummary', 'Queued WhatsApp summary to ' + maskPhoneForLog(recipient) + ' messageId=' + (outbound.messageId || ''));
  });
  logRun('INFO', 'sendWhatsAppDailySummary', 'Sent WhatsApp summary to ' + recipients.length + ' recipient(s).');
}

function testWhatsAppDailySummary() {
  sendWhatsAppDailySummary();
}

function buildWhatsAppSummaryMessage(rows, config) {
  return buildFamilyBudgetBriefMessage(config || getConfig());
}

function buildFamilyBudgetBriefMessage(config) {
  config = config || getConfig();
  const timezone = config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE;
  const summaryRows = readObjects(SHEETS.SUMMARY);
  const overall = summaryRows.filter(function (row) { return row['Budget Line'] === 'Overall Budget'; })[0] || {};
  const budgetRows = summaryRows.filter(function (row) { return row['Budget Line'] && row['Budget Line'] !== 'Overall Budget'; });
  const yesterdayRows = readObjects(SHEETS.YESTERDAY_EXPENSES);
  const period = getCurrentBudgetPeriod(config);
  const cashFlowPeriods = getLastCompletedCashFlowPeriodsFromSheet(3);

  const overallSpent = roundCurrency(overall.SpentEUR);
  const overallBudget = roundCurrency(overall.BudgetEUR);
  const overallRemaining = roundCurrency(overall.RemainingEUR || (overallBudget - overallSpent));
  const overallForecast = roundCurrency(overall.ForecastEUR);
  const overallRisk = roundCurrency(overallForecast - overallBudget);

  const budgetBlocks = budgetRows.map(formatSummaryBudgetLineForWhatsApp).filter(Boolean);
  const yesterdayBlocks = yesterdayRows.map(function (row) {
    return '• ' + sheetDateText(row.Date) + ' · ' + row.Category + ' — ' + formatEuro(row.AmountEUR) + ' from ' + row.Account + (row.Note ? ' — ' + row.Note : '');
  });
  const cashFlowBlocks = cashFlowPeriods.filter(function (item) {
    return item.hasCapturedBalance;
  }).map(function (item) {
    const sign = item.netSavings >= 0 ? '+' : '-';
    const changeText = item.hasPriorBalance ? sign + formatEuro(Math.abs(item.netSavings)) + ' change' : 'baseline captured';
    return '*' + item.period + ':* ' + changeText + ' · closing funds ' + formatEuro(item.availableFunds);
  });

  return [
    '💰 *Family Budget Brief*',
    Utilities.formatDate(new Date(), timezone, 'EEE, dd MMM yyyy') + ' · *' + period.display + '*',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '*Yesterday’s Expenses*',
    '',
    yesterdayBlocks.length ? yesterdayBlocks.join('\n') : 'No included Wallet expenses found for yesterday.',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '📊 *Overall*',
    'Spent: *' + formatEuro(overallSpent) + '* / ' + formatEuro(overallBudget),
    'Remaining: ' + formatEuro(overallRemaining) + ' · Forecast: ' + formatEuro(overallForecast),
    '━━━━━━━━━━━━━━━━━━',
    '',
    budgetBlocks.length ? budgetBlocks.join('\n\n') : 'No budget lines are selected for the Summary sheet yet.',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '*Cash Flow*',
    '',
    cashFlowBlocks.length ? cashFlowBlocks.join('\n') : 'No captured completed cash-flow periods yet.'
  ].join('\n');
}

function getLastCompletedCashFlowPeriodsFromSheet(count) {
  const limit = Math.max(1, Number(count) || 3);
  const rows = readObjects(SHEETS.CASH_FLOW_BALANCES).filter(function (row) {
    return String(row.RowType || '').toUpperCase() === 'TOTAL' && row.PeriodEnd;
  }).map(function (row) {
    return {
      periodStart: sheetDateText(row.PeriodStart),
      periodEnd: sheetDateText(row.PeriodEnd),
      period: row.Period || (sheetDateText(row.PeriodStart) + ' to ' + sheetDateText(row.PeriodEnd)),
      availableFunds: parseSheetNumber(row.ClosingBalanceEUR),
      netSavings: 0,
      hasPriorBalance: false,
      hasCapturedBalance: true
    };
  }).sort(function (a, b) {
    return String(a.periodEnd).localeCompare(String(b.periodEnd));
  });
  for (let index = 1; index < rows.length; index++) {
    rows[index].netSavings = roundCurrency(rows[index].availableFunds - rows[index - 1].availableFunds);
    rows[index].hasPriorBalance = true;
  }
  return rows.slice(Math.max(0, rows.length - limit)).reverse();
}

function formatSummaryBudgetLineForWhatsApp(row) {
  const rawName = String(row['Budget Line'] || '');
  const name = rawName.trim();
  if (!name) return '';
  const depth = Math.floor((rawName.match(/^\s*/) || [''])[0].length / 2);
  const spent = roundCurrency(row.SpentEUR);
  const budget = roundCurrency(row.BudgetEUR);
  const forecast = roundCurrency(row.ForecastEUR);
  const indent = Array(depth + 1).join('  ');
  const icon = getBudgetCategoryEmoji(name, name);
  return [
    indent + icon + ' *' + name + '*',
    indent + 'Spent: ' + formatEuro(spent) + ' / ' + formatEuro(budget),
    indent + 'Forecast: ' + formatEuro(forecast)
  ].join('\n');
}

function getCashFlowSummaryForPeriod(period) {
  const accounts = getNonCashAccountsForCashFlow();
  const includedIds = accounts.reduce(function (map, row) {
    if (row.AccountId) map[String(row.AccountId)] = true;
    return map;
  }, {});
  const includedNames = accounts.reduce(function (map, row) {
    if (row.Name) map[String(row.Name)] = true;
    return map;
  }, {});
  const currentFunds = accounts.reduce(function (sum, row) { return sum + parseSheetNumber(row.Balance); }, 0);
  const movements = readObjects(SHEETS.TRANSACTIONS).filter(function (row) {
    return includedIds[String(row.AccountId || '')] || includedNames[String(row.Account || '')];
  });
  const movementAfterPeriodEnd = movements.filter(function (row) {
    const dateText = sheetDateText(row.Date);
    return dateText >= period.endExclusiveText;
  }).reduce(function (sum, row) { return sum + signedTransactionAmount(row); }, 0);
  const availableFunds = roundCurrency(currentFunds - movementAfterPeriodEnd);
  const periodMovements = movements.filter(function (row) {
    const dateText = sheetDateText(row.Date);
    if (dateText < period.startText || dateText >= period.endExclusiveText) return false;
    return true;
  });
  const netSavings = roundCurrency(periodMovements.reduce(function (sum, row) { return sum + signedTransactionAmount(row); }, 0));
  return { availableFunds: availableFunds, netSavings: netSavings, transactionCount: periodMovements.length };
}

function getHistoricalCashFlowPeriods(config, count) {
  config = config || getConfig();
  count = Math.max(1, Number(count) || 6);
  const periods = [];
  for (let offset = -1; offset >= -count; offset--) {
    const period = getBudgetPeriodForOffset(config, offset);
    const summary = getCashFlowSummaryForPeriod(period);
    periods.push({ period: period, availableFunds: summary.availableFunds, netSavings: summary.netSavings, transactionCount: summary.transactionCount });
  }
  return periods;
}

function getHardcodedCashFlowClosingBalanceRows() {
  const config = getConfig();
  const manualSource = 'Manual Revolut historical closing balance';
  const periodApr = getBudgetPeriodForMonthEnd(2026, 4, config);
  const periodMay = getBudgetPeriodForMonthEnd(2026, 5, config);
  const rows = [];
  const manualBalances = [
    { period: periodApr, account: 'IE52...58 EUR', accountId: 'IE52...58:EUR', currency: 'EUR', balance: 4.88 },
    { period: periodApr, account: 'IE52...58 ZAR', accountId: 'IE52...58:ZAR', currency: 'ZAR', balance: 0 },
    { period: periodApr, account: 'IE52...78', accountId: 'IE52...78', currency: 'EUR', balance: 0 },
    { period: periodApr, account: 'e96...14', accountId: 'e96...14', currency: 'EUR', balance: 489.56 },
    { period: periodApr, account: 'Instant access savings', accountId: 'Instant access savings', currency: 'EUR', balance: 11351.55 },
    { period: periodMay, account: 'IE52...58 EUR', accountId: 'IE52...58:EUR', currency: 'EUR', balance: 270.99 },
    { period: periodMay, account: 'IE52...58 ZAR', accountId: 'IE52...58:ZAR', currency: 'ZAR', balance: 0 },
    { period: periodMay, account: 'IE52...78', accountId: 'IE52...78', currency: 'EUR', balance: 0 },
    { period: periodMay, account: 'e96...14', accountId: 'e96...14', currency: 'EUR', balance: 3200.88 },
    { period: periodMay, account: 'Instant access savings', accountId: 'Instant access savings', currency: 'EUR', balance: 30714.10 }
  ];
  [periodApr, periodMay].forEach(function (period) {
    const accountRows = manualBalances.filter(function (item) { return item.period === period; }).map(function (item) {
      return buildCashFlowRow(item.period, item.period.endText + 'T22:00:00', 'ACCOUNT', item.account, item.accountId, item.currency, item.balance, convertAmountToEur(item.balance, item.currency, config), manualSource, 'Hard-wired from user-provided previous-month Revolut closing balances.');
    });
    const totalEur = accountRows.reduce(function (sum, row) { return sum + parseSheetNumber(row[9]); }, 0);
    rows.push(buildCashFlowRow(period, period.endText + 'T22:00:00', 'TOTAL', 'All non-cash accounts', '', 'EUR', totalEur, totalEur, manualSource, 'Hard-wired from user-provided previous-month Revolut closing balances.'));
    accountRows.forEach(function (row) { rows.push(row); });
  });
  return rows;
}

function existingRowsToCashFlowRows(existingRows) {
  return (existingRows || []).filter(function (row) {
    return row.PeriodEnd && row.RowType && String(row.Source || '').indexOf('Auto-captured Wallet') === 0;
  }).map(function (row) {
    return [
      sheetDateText(row.PeriodStart),
      sheetDateText(row.PeriodEnd),
      row.Period,
      row.CapturedAt,
      row.RowType,
      row.Account,
      row.AccountId,
      row.Currency,
      parseSheetNumber(row.ClosingBalance),
      parseSheetNumber(row.ClosingBalanceEUR),
      row.Source,
      row.Notes
    ];
  });
}

function mergeCashFlowBalanceRows(rows) {
  const map = {};
  (rows || []).forEach(function (row) {
    const key = [row[1], row[4], row[6] || row[5]].join('|');
    map[key] = row;
  });
  return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
    const periodCompare = String(a[1]).localeCompare(String(b[1]));
    if (periodCompare !== 0) return periodCompare;
    const rowTypeCompare = String(b[4]).localeCompare(String(a[4]));
    if (rowTypeCompare !== 0) return rowTypeCompare;
    return String(a[5]).localeCompare(String(b[5]));
  });
}

function buildCashFlowRow(period, capturedAt, rowType, account, accountId, currency, closingBalance, closingBalanceEur, source, notes) {
  return [
    period.startText,
    period.endText,
    period.label,
    capturedAt,
    rowType,
    account,
    accountId,
    currency,
    roundCurrency(closingBalance),
    roundCurrency(closingBalanceEur),
    source,
    notes
  ];
}

function getBudgetPeriodForMonthEnd(year, month, config) {
  config = config || getConfig();
  const startDay = Math.max(1, Math.min(31, Number(config.BUDGET_MONTH_START_DAY || CONFIG_DEFAULTS.BUDGET_MONTH_START_DAY) || 25));
  const timezone = config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE;
  const endInclusive = safeMonthDate(year, month - 1, startDay - 1);
  const endExclusive = safeMonthDate(year, month - 1, startDay);
  const start = safeMonthDate(year, month - 2, startDay);
  return {
    start: start,
    endExclusive: endExclusive,
    endInclusive: endInclusive,
    startText: Utilities.formatDate(start, timezone, 'yyyy-MM-dd'),
    endExclusiveText: Utilities.formatDate(endExclusive, timezone, 'yyyy-MM-dd'),
    endText: Utilities.formatDate(endInclusive, timezone, 'yyyy-MM-dd'),
    label: Utilities.formatDate(start, timezone, 'dd MMM') + ' to ' + Utilities.formatDate(endInclusive, timezone, 'dd MMM yyyy'),
    display: Utilities.formatDate(start, timezone, 'dd MMM') + ' to ' + Utilities.formatDate(endInclusive, timezone, 'dd MMM yyyy')
  };
}

function getAllCompletedBudgetPeriodsFromTransactions(config) {
  config = config || getConfig();
  const transactions = readObjects(SHEETS.TRANSACTIONS).map(function (row) { return sheetDateText(row.Date); }).filter(Boolean).sort();
  if (!transactions.length) return [];

  const startDay = Math.max(1, Math.min(31, Number(config.BUDGET_MONTH_START_DAY || CONFIG_DEFAULTS.BUDGET_MONTH_START_DAY) || 25));
  const timezone = config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE;
  const earliest = parseDateText(transactions[0]);
  if (!earliest) return [];
  const earliestAnchorMonth = earliest.getDate() < startDay ? earliest.getMonth() - 1 : earliest.getMonth();
  let start = safeMonthDate(earliest.getFullYear(), earliestAnchorMonth, startDay);
  const currentPeriod = getCurrentBudgetPeriod(config);
  const periods = [];

  while (Utilities.formatDate(start, timezone, 'yyyy-MM-dd') < currentPeriod.startText) {
    const endExclusive = safeMonthDate(start.getFullYear(), start.getMonth() + 1, startDay);
    const endInclusive = new Date(endExclusive.getTime());
    endInclusive.setDate(endInclusive.getDate() - 1);
    periods.push({
      start: new Date(start.getTime()),
      endExclusive: endExclusive,
      endInclusive: endInclusive,
      startText: Utilities.formatDate(start, timezone, 'yyyy-MM-dd'),
      endExclusiveText: Utilities.formatDate(endExclusive, timezone, 'yyyy-MM-dd'),
      endText: Utilities.formatDate(endInclusive, timezone, 'yyyy-MM-dd'),
      label: Utilities.formatDate(start, timezone, 'dd MMM') + ' to ' + Utilities.formatDate(endInclusive, timezone, 'dd MMM yyyy')
    });
    start = endExclusive;
  }
  return periods;
}

function getNonCashAccountClosingDetailsForPeriods(periods) {
  const accounts = getNonCashAccountsForCashFlow().map(function (row) {
    return {
      accountId: String(row.AccountId || ''),
      accountName: String(row.Name || ''),
      currentBalance: parseSheetNumber(row.Balance)
    };
  });
  const accountIdMap = accounts.reduce(function (map, account) {
    if (account.accountId) map[account.accountId] = true;
    return map;
  }, {});
  const accountNameMap = accounts.reduce(function (map, account) {
    if (account.accountName) map[account.accountName] = true;
    return map;
  }, {});
  const transactions = readObjects(SHEETS.TRANSACTIONS).filter(function (row) {
    return accountIdMap[String(row.AccountId || '')] || accountNameMap[String(row.Account || '')];
  }).map(function (row) {
    return {
      accountId: String(row.AccountId || ''),
      accountName: String(row.Account || ''),
      dateText: sheetDateText(row.Date),
      signedAmount: signedTransactionAmount(row)
    };
  });

  return periods.map(function (period) {
    const accountRows = accounts.map(function (account) {
      const accountTransactions = transactions.filter(function (row) {
        return (account.accountId && row.accountId === account.accountId) || (!account.accountId && row.accountName === account.accountName);
      });
      const movementAfterPeriodEnd = accountTransactions.filter(function (row) {
        return row.dateText >= period.endExclusiveText;
      }).reduce(function (sum, row) { return sum + row.signedAmount; }, 0);
      const periodTransactions = accountTransactions.filter(function (row) {
        return row.dateText >= period.startText && row.dateText < period.endExclusiveText;
      });
      const netMovement = periodTransactions.reduce(function (sum, row) { return sum + row.signedAmount; }, 0);
      return {
        accountId: account.accountId,
        accountName: account.accountName,
        closingBalance: account.currentBalance - movementAfterPeriodEnd,
        netMovement: netMovement,
        transactionCount: periodTransactions.length
      };
    });
    return {
      period: period,
      accounts: accountRows,
      totalClosingBalance: accountRows.reduce(function (sum, row) { return sum + row.closingBalance; }, 0),
      totalNetMovement: accountRows.reduce(function (sum, row) { return sum + row.netMovement; }, 0),
      totalTransactionCount: accountRows.reduce(function (sum, row) { return sum + row.transactionCount; }, 0)
    };
  });
}

function getNonCashAccountsForCashFlow() {
  return readObjects(SHEETS.ACCOUNTS).filter(function (row) {
    const rawType = String(row.RawType || '').toLowerCase();
    const name = String(row.Name || '').toLowerCase();
    return rawType.indexOf('cash') < 0 && name !== 'cash';
  });
}

function signedTransactionAmount(row) {
  const amount = parseSheetNumber(row.AmountEUR);
  return String(row.Type).toLowerCase() === 'expense' ? -amount : amount;
}

function sheetDateText(value) {
  const timezone = CONFIG_DEFAULTS.TIMEZONE;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const date = new Date(text);
  return isNaN(date.getTime()) ? text : Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
}

function parseDateText(text) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getCurrentBudgetPeriod(config) {
  return getBudgetPeriodForOffset(config || getConfig(), 0);
}

function getBudgetPeriodForOffset(config, offset) {
  config = config || getConfig();
  const startDay = Math.max(1, Math.min(31, Number(config.BUDGET_MONTH_START_DAY || CONFIG_DEFAULTS.BUDGET_MONTH_START_DAY) || 25));
  const today = new Date();
  const anchorMonth = new Date(today.getFullYear(), today.getMonth() - (today.getDate() < startDay ? 1 : 0), 1);
  offset = Number(offset) || 0;
  const start = safeMonthDate(anchorMonth.getFullYear(), anchorMonth.getMonth() + offset, startDay);
  const endExclusive = safeMonthDate(anchorMonth.getFullYear(), anchorMonth.getMonth() + offset + 1, startDay);
  const endInclusive = new Date(endExclusive.getTime());
  endInclusive.setDate(endInclusive.getDate() - 1);
  const timezone = config.TIMEZONE || CONFIG_DEFAULTS.TIMEZONE;
  return {
    start: start,
    endExclusive: endExclusive,
    endInclusive: endInclusive,
    startText: Utilities.formatDate(start, timezone, 'yyyy-MM-dd'),
    endExclusiveText: Utilities.formatDate(endExclusive, timezone, 'yyyy-MM-dd'),
    endText: Utilities.formatDate(endInclusive, timezone, 'yyyy-MM-dd'),
    label: Utilities.formatDate(start, timezone, 'dd MMM') + ' to ' + Utilities.formatDate(endInclusive, timezone, 'dd MMM yyyy'),
    display: Utilities.formatDate(start, timezone, 'dd MMM') + ' to ' + Utilities.formatDate(endInclusive, timezone, 'dd MMM yyyy')
  };
}

function safeMonthDate(year, month, day) {
  const first = new Date(year, month, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, lastDay));
}

function getBudgetStatusIcon(status) {
  if (status === 'OK') return '✅';
  if (status === 'Watch') return '⚠️';
  if (status === 'At risk') return '🟠';
  if (status === 'Over budget' || status === 'Over forecast') return '🔴';
  return 'ℹ️';
}

function formatEuro(value) {
  const rounded = roundCurrency(value);
  return '€' + rounded.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sendWhatsAppTextMessage(toNumber, message, config) {
  const token = stripWrappingQuotes(PropertiesService.getScriptProperties().getProperty('WHATSAPP_ACCESS_TOKEN'));
  if (!token) throw codedError(ERROR_CODES.WHATSAPP_SEND, 'Missing WHATSAPP_ACCESS_TOKEN script property.', {});
  const phoneNumberId = PropertiesService.getScriptProperties().getProperty('WHATSAPP_PHONE_NUMBER_ID') || config.WHATSAPP_PHONE_NUMBER_ID || CONFIG_DEFAULTS.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) throw codedError(ERROR_CODES.WHATSAPP_SEND, 'Missing WHATSAPP_PHONE_NUMBER_ID in Settings or Script Properties.', {});

  const apiVersion = config.WHATSAPP_API_VERSION || 'v24.0';
  const url = 'https://graph.facebook.com/' + encodeURIComponent(apiVersion) + '/' + encodeURIComponent(phoneNumberId) + '/messages';
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeE164ForWhatsApp(toNumber),
    type: 'text',
    text: {
      preview_url: false,
      body: message
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      Authorization: 'Bearer ' + token
    }
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  console.log('sendWhatsAppTextMessage to=' + maskPhoneForLog(toNumber) + ' status=' + code + ' body=' + body.slice(0, 500));
  let json = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch (error) {
    json = {};
  }
  if (code < 200 || code >= 300) throw codedError(ERROR_CODES.WHATSAPP_SEND, 'WhatsApp Cloud API failed: HTTP ' + code, { to: maskPhoneForLog(toNumber), status: code, body: body.slice(0, 1000) });
  return { status: code, body: body, messageId: json.messages && json.messages[0] && json.messages[0].id ? json.messages[0].id : '' };
}

function handleWhatsAppWebhookPayload(payload) {
  logWhatsAppStatusEvents(payload);
  const messages = extractWhatsAppIncomingMessages(payload);
  console.log('handleWhatsAppWebhookPayload messages=' + messages.length);
  if (!messages.length) {
    logRun('INFO', 'handleWhatsAppWebhookPayload', 'Received WhatsApp webhook without inbound user messages.');
    return;
  }

  const config = getConfig();
  messages.forEach(function (message) {
    if (!message.from) return;
    let messageId = getWhatsAppMessageId(message);
    try {
      const text = getWhatsAppInboundText(message);
      console.log('WhatsApp inbound from=' + maskPhoneForLog(message.from) + ' type=' + (message.type || '') + ' text=' + String(text || '').slice(0, 80));
      const logState = beginMessageProcessing(message, text);
      messageId = logState.messageId;
      if (logState.duplicate) {
        console.log('Duplicate WhatsApp message ignored messageId=' + messageId);
        return;
      }

      if (!isInboundWithinStaleWindow(messageId, config)) {
        updateMessageLog(messageId, { Status: 'STALE_IGNORED', ErrorCode: ERROR_CODES.STALE_MESSAGE, ErrorMessage: 'Message was stale before processing started.' });
        logRun('WARN', 'handleWhatsAppWebhookPayload', 'Ignored stale WhatsApp message before processing messageId=' + messageId + '.');
        return;
      }

      if (!text) {
        throw codedError(ERROR_CODES.UNSUPPORTED_MESSAGE, 'Unsupported WhatsApp message type. Send Budget or a text budget question.', { messageType: message.type || '' });
      }

      if (text.trim().toLowerCase() === 'budget') {
        const reply = buildWhatsAppBudgetCommandReply();
        const outbound = sendWhatsAppTextMessage(message.from, reply, config);
        updateMessageLog(messageId, { Status: 'COMPLETED', OutboundAt: new Date(), OutboundMessageId: outbound.messageId || '', Notes: 'Budget command handled locally.' });
        logRun('INFO', 'handleWhatsAppWebhookPayload', 'Replied to Budget command from ' + maskPhoneForLog(message.from) + '.');
        return;
      }

      const claudeResult = callClaudeFamilyBudgetAssistant(text, message.from, messageId);
      updateMessageLog(messageId, {
        ClaudeSessionId: claudeResult.sessionId || '',
        ClaudeRequestIds: (claudeResult.requestIds || []).join(','),
        ClaudeEventSummary: claudeResult.eventSummary || '',
        ContextBytes: claudeResult.contextBytes || '',
        TransactionCount: claudeResult.transactionCount || ''
      });
      if (!assertMessageStillSendable(messageId, config)) {
        updateMessageLog(messageId, { Status: 'STALE_IGNORED', ErrorCode: ERROR_CODES.STALE_MESSAGE, ErrorMessage: 'Message was stale before Claude response send.' });
        return;
      }
      const outbound = sendWhatsAppTextMessage(message.from, claudeResult.message, config);
      updateMessageLog(messageId, { Status: 'COMPLETED', OutboundAt: new Date(), OutboundMessageId: outbound.messageId || '' });
      logRun('INFO', 'handleWhatsAppWebhookPayload', 'Relayed WhatsApp message to Claude for ' + maskPhoneForLog(message.from) + '.');
    } catch (error) {
      const coded = normalizeError(error, 'ERR_WHATSAPP_HANDLER');
      console.error('WhatsApp message handling error for ' + maskPhoneForLog(message.from) + ': ' + (coded.stack || coded.message));
      logRun('ERROR', 'handleWhatsAppWebhookPayload', 'Failed to handle message from ' + maskPhoneForLog(message.from) + ': ' + (coded.stack || coded.message));
      if (messageId) updateMessageLog(messageId, { Status: 'FAILED', ErrorCode: coded.code, ErrorMessage: formatErrorDetailForLog(coded) });
      try {
        if (!messageId || isInboundWithinStaleWindow(messageId, config)) {
          const outbound = sendWhatsAppTextMessage(message.from, buildCodedWhatsAppErrorMessage(coded, messageId), config);
          if (messageId) updateMessageLog(messageId, { OutboundAt: new Date(), OutboundMessageId: outbound.messageId || '' });
        }
      } catch (sendError) {
        const sendCoded = normalizeError(sendError, ERROR_CODES.WHATSAPP_SEND);
        if (messageId) updateMessageLog(messageId, { ErrorCode: sendCoded.code, ErrorMessage: formatErrorDetailForLog(sendCoded) });
        console.error('Failed to send coded WhatsApp error: ' + (sendCoded.stack || sendCoded.message));
      }
    }
  });
}

function callClaudeFamilyBudgetAssistant(userText, fromNumber, messageId) {
  const claude = getClaudeConfig();
  const promptResult = buildClaudeWhatsAppPrompt(userText);
  const sessionPayload = {
    agent: claude.agentId,
    environment_id: claude.environmentId,
    title: 'WhatsApp budget question ' + maskPhoneForLog(fromNumber)
  };
  if (claude.vaultIds.length) sessionPayload.vault_ids = claude.vaultIds;
  const session = claudeRequestJson('post', '/sessions', sessionPayload, claude);
  if (!session.id) throw codedError(ERROR_CODES.CLAUDE_CONFIG, 'Claude session creation returned no id.', { requestId: session._requestId || '' });
  if (messageId) updateMessageLog(messageId, { ClaudeSessionId: session.id, ClaudeRequestIds: session._requestId || '', ContextBytes: promptResult.contextBytes, TransactionCount: promptResult.transactionCount });

  const sendEvent = claudeRequestJson('post', '/sessions/' + encodeURIComponent(session.id) + '/events', {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: promptResult.prompt }]
    }]
  }, claude);

  const reply = waitForClaudeAgentReply(session.id, claude, messageId);
  const requestIds = [session._requestId, sendEvent._requestId].concat(reply.requestIds || []).filter(Boolean);
  let formatted = formatClaudeReplyForWhatsApp(reply.text);
  if (reply.mcpAuthFailed) formatted = formatted + '\n\n⚠️ BudgetBakers MCP authentication failed, so this answer used the Google Sheets budget context already loaded into the app. Debug: ' + ERROR_CODES.CLAUDE_MCP_AUTH;
  return {
    message: formatted,
    sessionId: session.id,
    requestIds: requestIds,
    eventSummary: reply.eventSummary,
    contextBytes: promptResult.contextBytes,
    transactionCount: promptResult.transactionCount
  };
}

function getClaudeConfig() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = stripWrappingQuotes(props.getProperty('CLAUDE_API_KEY'));
  const agentId = stripWrappingQuotes(props.getProperty('CLAUDE_AGENT_ID'));
  const environmentId = stripWrappingQuotes(props.getProperty('CLAUDE_ENV_ID'));
  const vaultIds = String(stripWrappingQuotes(props.getProperty('CLAUDE_VAULT_IDS')) || stripWrappingQuotes(props.getProperty('CLAUDE_VAULT_ID')) || '').split(',').map(function (id) { return id.trim(); }).filter(Boolean);
  if (!apiKey) throw codedError(ERROR_CODES.CLAUDE_CONFIG, 'Missing CLAUDE_API_KEY script property.', {});
  if (!agentId) throw codedError(ERROR_CODES.CLAUDE_CONFIG, 'Missing CLAUDE_AGENT_ID script property.', {});
  if (!environmentId) throw codedError(ERROR_CODES.CLAUDE_CONFIG, 'Missing CLAUDE_ENV_ID script property.', {});
  return {
    apiKey: apiKey,
    agentId: agentId,
    environmentId: environmentId,
    vaultIds: vaultIds,
    baseUrl: 'https://api.anthropic.com/v1',
    version: '2023-06-01',
    beta: 'managed-agents-2026-04-01'
  };
}

function buildClaudeWhatsAppPrompt(userText) {
  const context = buildClaudeBudgetContext();
  const contextJson = JSON.stringify(context);
  const prompt = [
    'WhatsApp user question:',
    String(userText || '').slice(0, 2000),
    '',
    'Use this current Google Sheets budget context when relevant. The manualBudgets array is authoritative for category target amounts because those targets do not exist in BudgetBakers Wallet/MCP. Keep the reply concise and WhatsApp-friendly.',
    contextJson
  ].join('\n');
  const bytes = byteLength(prompt);
  const maxBytes = Number(getConfig().CLAUDE_CONTEXT_MAX_BYTES || CONFIG_DEFAULTS.CLAUDE_CONTEXT_MAX_BYTES);
  if (bytes > maxBytes) throw codedError(ERROR_CODES.CLAUDE_CONTEXT_TOO_LARGE, 'Claude context payload is too large to send safely.', { bytes: bytes, maxBytes: maxBytes, transactionCount: context.transactions.length });
  return { prompt: prompt, contextBytes: bytes, transactionCount: context.transactions.length };
}

function buildClaudeBudgetContext() {
  const transactions = readObjects(SHEETS.TRANSACTIONS).map(function (row) {
    return {
      date: row.Date,
      month: row.Month,
      account: row.Account,
      category: row.Category,
      type: row.Type,
      amountEUR: roundCurrency(row.AmountEUR),
      originalAmount: roundCurrency(row.OriginalAmount),
      originalCurrency: row.OriginalCurrency,
      note: row.Note
    };
  });
  const summary = readObjects(SHEETS.SUMMARY).slice(0, 20).map(function (row) {
    return {
      budgetLine: row['Budget Line'],
      budgetEUR: roundCurrency(row.BudgetEUR),
      spentEUR: roundCurrency(row.SpentEUR),
      remainingEUR: roundCurrency(row.RemainingEUR),
      usedPercent: Math.round((Number(row.UsedPercent) || 0) * 1000) / 10,
      forecastEUR: roundCurrency(row.ForecastEUR),
      forecastVsBudgetEUR: roundCurrency(row.ForecastVsBudgetEUR)
    };
  });
  const manualBudgets = readObjects(SHEETS.BUDGETS).map(function (row) {
    return {
      categoryId: row.CategoryId,
      category: row.Category,
      fullPath: row.Path,
      period: row.Period,
      forecastType: row['Forecast Type'],
      includeInExpenseCalculations: String(row['Include in Expense Calculations']).toUpperCase() === 'TRUE',
      includeInReport: String(row['Include in Report?']).toUpperCase() === 'TRUE',
      budgetEUR: roundCurrency(row.BudgetEUR),
      baselineMonth1EUR: roundCurrency(row.BaselineMonth1EUR),
      baselineMonth2EUR: roundCurrency(row.BaselineMonth2EUR),
      baselineMonth3EUR: roundCurrency(row.BaselineMonth3EUR),
      baselineAverageEUR: roundCurrency(row['3MonthBaselineAverageEUR']),
      currentMonthSpentEUR: roundCurrency(row.CurrentMonthSpentEUR),
      remainingEUR: roundCurrency(row.RemainingEUR),
      forecastEUR: roundCurrency(row.ForecastEUR),
      forecastVsBudgetEUR: roundCurrency(row.ForecastVsBudgetEUR)
    };
  });
  const yesterdayExpenses = readObjects(SHEETS.YESTERDAY_EXPENSES);
  return {
    date: formatDateOnly(new Date()),
    currency: getConfig().CURRENCY || 'EUR',
    source: 'Google Sheets Family Budget Tracker',
    budgetNote: 'manualBudgets contains the complete Budgets sheet and is authoritative for target BudgetEUR amounts; BudgetBakers Wallet/MCP does not contain these manual targets.',
    transactions: transactions,
    summary: summary,
    manualBudgets: manualBudgets,
    yesterdayExpenses: yesterdayExpenses
  };
}

function waitForClaudeAgentReply(sessionId, claude, messageId) {
  const started = Date.now();
  let lastError = '';
  let lastErrorType = '';
  let mcpAuthFailed = false;
  let eventSummary = '';
  const requestIds = [];
  const timeoutMs = Math.min(Number(getConfig().CLAUDE_POLL_TIMEOUT_SECONDS || CONFIG_DEFAULTS.CLAUDE_POLL_TIMEOUT_SECONDS) * 1000, 120000);
  const intervalMs = Math.max(Number(getConfig().CLAUDE_POLL_INTERVAL_MS || CONFIG_DEFAULTS.CLAUDE_POLL_INTERVAL_MS), 1000);
  while (Date.now() - started < timeoutMs) {
    Utilities.sleep(intervalMs);
    if (messageId && !assertMessageStillSendable(messageId, getConfig())) throw codedError(ERROR_CODES.STALE_MESSAGE, 'Message became stale while waiting for Claude.', { sessionId: sessionId });
    const events = claudeRequestJson('get', '/sessions/' + encodeURIComponent(sessionId) + '/events', null, claude);
    if (events._requestId) requestIds.push(events._requestId);
    const data = Array.isArray(events.data) ? events.data : [];
    eventSummary = summarizeClaudeEvents(data);
    const errors = data.filter(function (event) { return event.type === 'session.error' && event.error && event.error.message; });
    if (errors.length) {
      const latestError = errors[errors.length - 1].error;
      lastError = latestError.message || '';
      lastErrorType = latestError.type || '';
      if (isMcpAuthenticationError(latestError)) mcpAuthFailed = true;
    }
    const agentMessages = data.filter(function (event) { return event.type === 'agent.message' && Array.isArray(event.content); });
    if (agentMessages.length) {
      const latest = agentMessages[agentMessages.length - 1];
      const text = latest.content.map(function (block) { return block && block.type === 'text' ? block.text : ''; }).join('\n').trim();
      if (text) return { text: text, mcpAuthFailed: mcpAuthFailed, eventSummary: eventSummary, requestIds: uniqueValues(requestIds) };
    }
  }
  if (mcpAuthFailed) throw codedError(ERROR_CODES.CLAUDE_MCP_AUTH, 'Claude BudgetBakers MCP authentication failed and no agent.message was returned before timeout.', { sessionId: sessionId, lastError: lastError, lastErrorType: lastErrorType, eventSummary: eventSummary, requestIds: uniqueValues(requestIds) });
  if (lastError) throw codedError(ERROR_CODES.CLAUDE_TIMEOUT, 'Claude session error before reply: ' + lastError, { sessionId: sessionId, lastErrorType: lastErrorType, eventSummary: eventSummary, requestIds: uniqueValues(requestIds) });
  throw codedError(ERROR_CODES.CLAUDE_TIMEOUT, 'Claude did not return an agent.message before timeout.', { sessionId: sessionId, timeoutMs: timeoutMs, eventSummary: eventSummary, requestIds: uniqueValues(requestIds) });
}

function claudeRequestJson(method, path, payload, claude) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      'x-api-key': claude.apiKey,
      'anthropic-version': claude.version,
      'anthropic-beta': claude.beta
    }
  };
  if (payload !== null && payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(claude.baseUrl + path, options);
  const code = response.getResponseCode();
  const body = response.getContentText();
  const headers = response.getAllHeaders ? response.getAllHeaders() : {};
  const requestId = headers['request-id'] || headers['Request-Id'] || headers['Request-ID'] || '';
  console.log('Claude API ' + method.toUpperCase() + ' ' + path + ' status=' + code + ' requestId=' + requestId + ' body=' + body.slice(0, 500));
  let json = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch (error) {
    throw codedError(httpStatusToClaudeErrorCode(code), 'Claude API returned non-JSON response: HTTP ' + code, { status: code, path: path, requestId: requestId, body: body.slice(0, 1000) });
  }
  json._requestId = requestId || json.request_id || '';
  json._httpStatus = code;
  if (code < 200 || code >= 300) {
    const message = json.error && json.error.message ? json.error.message : body.slice(0, 500);
    throw codedError(httpStatusToClaudeErrorCode(code), 'Claude API failed: HTTP ' + code + ' ' + message, { status: code, path: path, requestId: json._requestId, errorType: json.error && json.error.type ? json.error.type : '', body: body.slice(0, 1000) });
  }
  return json;
}

function formatClaudeReplyForWhatsApp(reply) {
  const text = String(reply || '').trim();
  if (!text) throw codedError(ERROR_CODES.CLAUDE_EMPTY_REPLY, 'Claude returned an empty reply.', {});
  return text.length <= 3500 ? text : text.slice(0, 3450) + '\n\n…reply shortened for WhatsApp.';
}

function extractWhatsAppIncomingMessages(payload) {
  const messages = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  entries.forEach(function (entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach(function (change) {
      const value = change.value || {};
      const inbound = Array.isArray(value.messages) ? value.messages : [];
      inbound.forEach(function (message) { messages.push(message); });
    });
  });
  return messages;
}

function extractWhatsAppStatusEvents(payload) {
  const statuses = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  entries.forEach(function (entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach(function (change) {
      const value = change.value || {};
      const outboundStatuses = Array.isArray(value.statuses) ? value.statuses : [];
      outboundStatuses.forEach(function (status) { statuses.push(status); });
    });
  });
  return statuses;
}

function logWhatsAppStatusEvents(payload) {
  const statuses = extractWhatsAppStatusEvents(payload);
  statuses.forEach(function (status) {
    const recipient = status.recipient_id ? maskPhoneForLog(status.recipient_id) : 'unknown';
    const state = status.status || 'unknown';
    const messageId = status.id || '';
    const errors = Array.isArray(status.errors) ? status.errors.map(function (error) {
      return [error.code || '', error.title || '', error.message || '', error.error_data && error.error_data.details ? error.error_data.details : ''].filter(Boolean).join(' ');
    }).join(' | ') : '';
    const detail = 'messageId=' + messageId + ' recipient=' + recipient + ' status=' + state + (errors ? ' errors=' + errors : '');
    console.log('WhatsApp status ' + detail);
    logRun(state === 'failed' ? 'ERROR' : 'INFO', 'WhatsAppStatus', detail);
  });
}

function getWhatsAppInboundText(message) {
  if (!message) return '';
  if (message.type === 'text' && message.text && message.text.body) return String(message.text.body);
  if (message.type === 'button' && message.button && message.button.text) return String(message.button.text);
  if (message.type === 'interactive' && message.interactive) {
    if (message.interactive.button_reply && message.interactive.button_reply.title) return String(message.interactive.button_reply.title);
    if (message.interactive.list_reply && message.interactive.list_reply.title) return String(message.interactive.list_reply.title);
  }
  return '';
}

function buildWhatsAppBudgetCommandReply() {
  return buildFamilyBudgetBriefMessage(getConfig());
}

function getBudgetReplyStatusIcon(spent, target, forecast) {
  if (target <= 0) return spent > 0 || forecast > 0 ? '⚪' : '✅';
  if (spent > target || forecast > target) return '🔴';
  if (spent / target >= 0.8 || forecast / target >= 0.9) return '🟠';
  return '✅';
}

function getBudgetReplyRemainingText(remaining) {
  return remaining < 0 ? ' · over ' + formatEuro(Math.abs(remaining)) : ' · left ' + formatEuro(remaining);
}

function getBudgetReplyAmountLine(spent, target, forecast) {
  if (target <= 0) return 'Spent ' + formatEuro(spent) + ' · no target set · forecast ' + formatEuro(forecast);
  return 'Spent ' + formatEuro(spent) + ' / ' + formatEuro(target) + ' · forecast ' + formatEuro(forecast);
}

function getBudgetReplyCompactLine(spent, target, forecast, remaining) {
  if (target <= 0) return formatEuro(spent) + ' spent · no target · fcst ' + formatEuro(forecast);
  return formatEuro(spent) + '/' + formatEuro(target) + ' · fcst ' + formatEuro(forecast) + getBudgetReplyRemainingText(remaining);
}

function getBudgetProgressBar(spent, target) {
  if (target <= 0) return '';
  const ratio = Math.max(0, Math.min(spent / target, 1));
  const filled = Math.round(ratio * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function getBudgetCategoryEmoji(category, categoryType) {
  const values = [category, categoryType].map(function (value) { return String(value || '').trim().toLowerCase(); }).filter(Boolean);
  for (let index = 0; index < values.length; index++) {
    if (STANDARD_BUDGET_ICON_LIBRARY[values[index]]) return STANDARD_BUDGET_ICON_LIBRARY[values[index]];
  }
  const key = values.join(' ');
  if (key.indexOf('bar') >= 0 || key.indexOf('cafe') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['bar cafe'];
  if (key.indexOf('restaurant') >= 0 || key.indexOf('fast food') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['restaurants & fast food'];
  if (key.indexOf('grocery') >= 0 || key.indexOf('groceries') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.groceries;
  if (key.indexOf('alcohol') >= 0 || key.indexOf('tobacco') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['alcohol, tobacco'];
  if (key.indexOf('clothes') >= 0 || key.indexOf('shoes') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['clothes & shoes'];
  if (key.indexOf('drugstore') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.drugstore;
  if (key.indexOf('electronics') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['electronics & accessories'];
  if (key.indexOf('home') >= 0 || key.indexOf('garden') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['home & garden'];
  if (key.indexOf('kids') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.kids;
  if (key.indexOf('food') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['food & drinks'];
  if (key.indexOf('housing') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.housing;
  if (key.indexOf('shopping') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.shopping;
  if (key.indexOf('vehicle') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.vehicle;
  if (key.indexOf('transport') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.transportation;
  if (key.indexOf('pc') >= 0 || key.indexOf('communication') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['pc, communication'];
  if (key.indexOf('financial') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['financial expenses'];
  if (key.indexOf('life') >= 0 || key.indexOf('entertainment') >= 0) return STANDARD_BUDGET_ICON_LIBRARY['life & entertainment'];
  if (key.indexOf('unknown') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.unknown;
  if (key.indexOf('other') >= 0) return STANDARD_BUDGET_ICON_LIBRARY.others;
  return '•';
}

function getWhatsAppWebhookVerifyToken() {
  return PropertiesService.getScriptProperties().getProperty('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || getConfig().WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
}

function maskPhoneForLog(value) {
  const digits = normalizeE164ForWhatsApp(value);
  if (digits.length <= 4) return '****';
  return '***' + digits.slice(-4);
}

function getWhatsAppRecipients(config) {
  return String(config.WHATSAPP_TO_NUMBERS || '').split(',').map(function (value) {
    return value.trim();
  }).filter(Boolean);
}

function normalizeE164ForWhatsApp(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function stripWrappingQuotes(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function removeLegacyDashboardSheet() {
  const ss = getSpreadsheet();
  const dashboard = ss.getSheetByName('Dashboard');
  if (dashboard) ss.deleteSheet(dashboard);
}

function buildBudgetHierarchyRows(categories) {
  const nodesById = {};
  const nodesByType = {};
  categories.forEach(function (category) {
    const id = String(category.CategoryId || '');
    if (!id) return;
    const path = String(category.FullPath || category.Category || id);
    const parts = path.split(' > ');
    const categoryType = String(category.Type || parts[0] || 'Other');
    nodesById[id] = {
      categoryId: id,
      parentId: String(category.ParentCategoryId || ''),
      category: String(category.Category || parts[parts.length - 1] || id),
      path: path,
      categoryType: categoryType,
      depth: Number(category.Level || Math.max(parts.length - 1, 0)),
      children: []
    };
    if (!nodesByType[nodesById[id].categoryType]) nodesByType[nodesById[id].categoryType] = [];
    nodesByType[nodesById[id].categoryType].push(nodesById[id]);
  });
  Object.keys(nodesById).forEach(function (id) {
    const node = nodesById[id];
    if (node.parentId && nodesById[node.parentId]) nodesById[node.parentId].children.push(node);
  });

  const rows = [{
    categoryId: '',
    parentId: '',
    category: 'Overall Budget',
    display: 'Overall Budget',
    path: '__OVERALL_BUDGET__',
    categoryType: 'Overall',
    depth: 0,
    rowType: 'OVERALL'
  }];
  Object.keys(nodesByType).sort(function (a, b) { return budgetTypeSortKey(a).localeCompare(budgetTypeSortKey(b)); }).forEach(function (type) {
    rows.push({
      categoryId: '',
      parentId: '',
      category: type,
      display: type,
      path: type,
      categoryType: type,
      depth: 0,
      rowType: 'TYPE'
    });
    const roots = nodesByType[type].filter(function (node) {
      return !node.parentId || !nodesById[node.parentId] || nodesById[node.parentId].categoryType !== type;
    }).sort(function (a, b) { return a.path.localeCompare(b.path); });
    roots.forEach(function (root) {
      rows.push({
        categoryId: root.categoryId,
        parentId: root.parentId,
        category: root.category,
        display: '  ' + root.category,
        path: root.path,
        categoryType: root.categoryType,
        depth: 1,
        rowType: 'CATEGORY'
      });
      appendBudgetChildren(root, rows);
    });
  });
  return rows;
}

function budgetTypeSortKey(type) {
  const lower = String(type || '').toLowerCase();
  if (lower.indexOf('expense') >= 0) return '1-' + lower;
  if (lower.indexOf('income') >= 0) return '2-' + lower;
  if (lower.indexOf('transfer') >= 0) return '3-' + lower;
  return '4-' + lower;
}

function appendBudgetChildren(node, rows) {
  node.children.sort(function (a, b) { return a.path.localeCompare(b.path); }).forEach(function (child) {
    rows.push({
      categoryId: child.categoryId,
      parentId: child.parentId,
      category: child.category,
      display: Array(child.depth + 2).join('  ') + child.category,
      path: child.path,
      categoryType: child.categoryType,
      depth: child.depth + 1,
      rowType: 'CATEGORY'
    });
    appendBudgetChildren(child, rows);
  });
}

function isExpenseLikeBudgetNode(node) {
  const text = String((node && (node.categoryType + ' ' + node.path)) || '').toLowerCase();
  return text.indexOf('income') < 0 && text.indexOf('transfer') < 0;
}

function getBudgetDefaultSelection(rowType, categoryType, category) {
  const name = String(category || '').trim();
  const type = String(categoryType || '').trim();
  const dayToDay = 'Day-to-day';
  if (rowType === 'OVERALL') return { period: 'Monthly', forecastType: dayToDay, budgetEUR: '6890', report: 'TRUE', expense: 'TRUE' };
  if (rowType === 'TYPE') {
    const typeDefaults = {
      'Financial expenses': ['50', 'TRUE', 'TRUE'],
      'Income': ['0', 'FALSE', 'FALSE'],
      'Food & Drinks': ['2000', 'TRUE', 'TRUE'],
      'Housing': ['2800', 'TRUE', 'TRUE'],
      'Investments': ['0', 'FALSE', 'FALSE'],
      'Life & Entertainment': ['650', 'TRUE', 'TRUE'],
      'Others': ['85', 'TRUE', 'TRUE'],
      'PC, Communication': ['305', 'TRUE', 'TRUE'],
      'Shopping': ['900', 'TRUE', 'TRUE'],
      'System categories': ['0', 'FALSE', 'FALSE'],
      'Transportation': ['20', 'TRUE', 'TRUE'],
      'Unknown': ['0', 'TRUE', 'TRUE'],
      'Vehicle': ['80', 'TRUE', 'TRUE']
    };
    const values = typeDefaults[name] || ['', 'FALSE', 'FALSE'];
    return { period: 'Monthly', forecastType: dayToDay, budgetEUR: values[0], report: values[1], expense: values[2] };
  }
  const childDefaults = {
    'Financial expenses|Advisory': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Aliments (Financial expenses)': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Charges, fees': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Financial expenses': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Fines': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Insurances': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Loan, interests': ['', 'FALSE', 'TRUE'],
    'Financial expenses|Savings': ['', 'FALSE', 'FALSE'],
    'Financial expenses|Taxes': ['', 'FALSE', 'TRUE'],
    'Income|Aliments (Income)': ['', 'FALSE', 'FALSE'],
    'Income|Checks, coupons': ['', 'FALSE', 'FALSE'],
    'Income|Dues, grants': ['', 'FALSE', 'FALSE'],
    'Income|Gifts': ['', 'FALSE', 'FALSE'],
    'Income|Income': ['', 'FALSE', 'FALSE'],
    'Income|Interest, dividends': ['', 'FALSE', 'FALSE'],
    'Income|Lending, renting': ['', 'FALSE', 'FALSE'],
    'Income|Lottery, gambling (Income)': ['', 'FALSE', 'FALSE'],
    'Income|Refunds': ['', 'FALSE', 'FALSE'],
    'Income|Rental, income': ['', 'FALSE', 'FALSE'],
    'Income|Sale': ['', 'FALSE', 'FALSE'],
    'Income|Wage, invoices': ['', 'FALSE', 'FALSE'],
    'Food & Drinks|Bar cafe': ['100', 'TRUE', 'TRUE'],
    'Food & Drinks|Food & Drinks': ['100', 'TRUE', 'TRUE'],
    'Food & Drinks|Groceries': ['1600', 'TRUE', 'TRUE'],
    'Food & Drinks|Restaurants & fast food': ['200', 'TRUE', 'TRUE'],
    'Housing|Energy & utilities': ['150', 'FALSE', 'TRUE'],
    'Housing|Housing': ['0', 'FALSE', 'TRUE'],
    'Housing|Insurance (Housing)': ['0', 'FALSE', 'TRUE'],
    'Housing|Maintenance & repairs': ['0', 'FALSE', 'TRUE'],
    'Housing|Mortgage': ['0', 'FALSE', 'TRUE'],
    'Housing|Rent': ['2250', 'FALSE', 'TRUE'],
    'Housing|Services': ['240', 'FALSE', 'TRUE'],
    'Investments|Collections': ['0', 'FALSE', 'FALSE'],
    'Investments|Fin. investments': ['0', 'FALSE', 'FALSE'],
    'Investments|Investments': ['0', 'FALSE', 'FALSE'],
    'Investments|Realty': ['0', 'FALSE', 'FALSE'],
    'Investments|Vehicles, chattels': ['0', 'FALSE', 'FALSE'],
    'Life & Entertainment|Active sport, fitness': ['160', 'FALSE', 'TRUE'],
    'Life & Entertainment|Alcohol, tobacco': ['200', 'TRUE', 'TRUE'],
    'Life & Entertainment|Books, audio, subscription': ['15', 'FALSE', 'TRUE'],
    'Life & Entertainment|Charity, gifts': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Culture, sport events': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Education & development': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Health care & doctor': ['150', 'FALSE', 'TRUE'],
    'Life & Entertainment|Hobbies': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Holidays, trips, hotels': ['100', 'FALSE', 'TRUE'],
    'Life & Entertainment|Life & Entertainment': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Life events': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Lottery, gambling (Life & Entertainment)': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Tv, streaming': ['0', 'FALSE', 'TRUE'],
    'Life & Entertainment|Wellness & beauty': ['25', 'FALSE', 'TRUE'],
    'Others|Missing': ['', 'FALSE', 'TRUE'],
    'Others|Cash Withdrawal': ['85', 'FALSE', 'TRUE'],
    'Others|Others': ['', 'FALSE', 'TRUE'],
    'PC, Communication|Internet': ['25', 'FALSE', 'TRUE'],
    'PC, Communication|PC, Communication': ['150', 'FALSE', 'TRUE'],
    'PC, Communication|Phone, cell phones': ['80', 'FALSE', 'TRUE'],
    'PC, Communication|Postal services': ['', 'FALSE', 'TRUE'],
    'PC, Communication|Software, apps, games': ['50', 'FALSE', 'TRUE'],
    'Shopping|Clothes & shoes': ['50', 'TRUE', 'TRUE'],
    'Shopping|Department Stores': ['', 'FALSE', 'TRUE'],
    'Shopping|Drugstore': ['100', 'TRUE', 'TRUE'],
    'Shopping|Electronics & accessories': ['50', 'TRUE', 'TRUE'],
    'Shopping|Free time': ['', 'FALSE', 'TRUE'],
    'Shopping|Gifts & joy': ['50', 'FALSE', 'TRUE'],
    'Shopping|Health & beauty': ['50', 'FALSE', 'TRUE'],
    'Shopping|Home & garden': ['100', 'TRUE', 'TRUE'],
    'Shopping|Jewels & accessories': ['', 'FALSE', 'TRUE'],
    'Shopping|Kids': ['50', 'TRUE', 'TRUE'],
    'Shopping|Pets & animals': ['30', 'FALSE', 'TRUE'],
    'Shopping|Shopping': ['400', 'TRUE', 'TRUE'],
    'Shopping|Stationery & tools': ['20', 'FALSE', 'TRUE'],
    'System categories|Debt': ['', 'FALSE', 'FALSE'],
    'System categories|Shopping list': ['', 'FALSE', 'FALSE'],
    'System categories|Transfer': ['', 'FALSE', 'FALSE'],
    'System categories|Uncategorized': ['', 'FALSE', 'TRUE'],
    'Transportation|Business trips': ['', 'FALSE', 'TRUE'],
    'Transportation|Long distance': ['', 'FALSE', 'TRUE'],
    'Transportation|Public transport': ['', 'FALSE', 'TRUE'],
    'Transportation|Taxi': ['20', 'FALSE', 'TRUE'],
    'Transportation|Transportation': ['', 'FALSE', 'TRUE'],
    'Unknown|Unknown expense': ['0', 'FALSE', 'TRUE'],
    'Unknown|Unknown income': ['', 'FALSE', 'FALSE'],
    'Vehicle|Fuel': ['20', 'FALSE', 'TRUE'],
    'Vehicle|Insurance (Vehicle)': ['0', 'FALSE', 'TRUE'],
    'Vehicle|Leasing': ['0', 'FALSE', 'TRUE'],
    'Vehicle|Parking': ['10', 'FALSE', 'TRUE'],
    'Vehicle|Rentals': ['0', 'FALSE', 'TRUE'],
    'Vehicle|Vehicle': ['0', 'FALSE', 'TRUE'],
    'Vehicle|Vehicle maintenance': ['50', 'FALSE', 'TRUE']
  };
  const values = childDefaults[type + '|' + name] || ['', 'FALSE', 'FALSE'];
  return { period: 'Monthly', forecastType: dayToDay, budgetEUR: values[0], report: values[1], expense: values[2] };
}

function applyBudgetFormatting(sheet, rowCount) {
  const rows = Math.max(rowCount, 1);
  sheet.setFrozenRows(1);
  sheet.showColumns(1, Math.min(sheet.getMaxColumns(), HEADERS.Budgets.length));
  sheet.hideColumns(16, 7);
  sheet.getRange(1, 1, 1, HEADERS.Budgets.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#444444');
  sheet.getRange(2, 1, rows, 6).setBackground('#ffffff');
  sheet.getRange(2, 7, rows, 5).setBackground('#d9eaf7');
  sheet.getRange(2, 12, rows, 4).setBackground('#fce4d6');
  applyBooleanValidation(sheet, [5, 6]);
  applyPeriodValidation(sheet, 2);
  applyForecastTypeValidation(sheet, 3);
  formatMoneyColumns(sheet, [4, 7, 8, 10, 11, 12, 13, 14, 15]);
  sheet.getRange(2, 9, rows, 1).setNumberFormat('0.0%');
  recreateFilter(sheet, HEADERS.Budgets.length);
  const values = sheet.getRange(2, 21, rows, 1).getValues();
  values.forEach(function (row, index) {
    if (row[0] === 'TYPE') sheet.getRange(index + 2, 1, 1, 15).setBackground('#d9d9d9').setFontWeight('bold');
  });
  sheet.autoResizeColumns(1, 15);
}

function applyPeriodValidation(sheet, column) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Monthly', 'Weekly', 'Yearly', 'Once', 'Ignore'], true).setAllowInvalid(false).build();
  sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function applyForecastTypeValidation(sheet, column) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Day-to-day', 'Recurring Expense'], true).setAllowInvalid(false).build();
  sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function writeCategoriesSheet(categories, categoryMap) {
  const rows = categories.map(function (category) {
    const id = getCategoryId(category);
    const parentId = getParentCategoryId(category);
    const fullPath = categoryMap[id] ? categoryMap[id].fullPath : getCategoryName(category);
    return [id, parentId, getCategoryName(category), fullPath, fullPath.split(' > ').length - 1, category.group && category.group.name ? category.group.name : '', 'TRUE', 'FALSE'];
  }).sort(function (a, b) { return String(a[3]).localeCompare(String(b[3])); });

  const existing = readObjects(SHEETS.CATEGORIES).reduce(function (map, row) {
    map[row.CategoryId] = row;
    return map;
  }, {});
  const merged = rows.map(function (row) {
    const saved = existing[row[0]] || {};
    if (saved.Enabled !== undefined && saved.Enabled !== '') row[6] = saved.Enabled;
    if (saved.Report !== undefined && saved.Report !== '') row[7] = saved.Report;
    return row;
  });

  replaceSheetData(getSheet(SHEETS.CATEGORIES), HEADERS.Categories, merged);
  applyBooleanValidation(getSheet(SHEETS.CATEGORIES), [7, 8]);
}

function writeAccountsSheet(accounts) {
  const existing = readObjects(SHEETS.ACCOUNTS).reduce(function (map, row) {
    if (row.AccountId) map[row.AccountId] = row;
    if (row.Name) map[row.Name] = row;
    return map;
  }, {});
  const rows = accounts.map(function (account) {
    const currency = account.balance && account.balance.currencyCode ? account.balance.currencyCode : (account.initialBalance && account.initialBalance.currencyCode ? account.initialBalance.currencyCode : '');
    const id = getAccountId(account);
    const name = account.name || '';
    const saved = existing[id] || existing[name] || {};
    const rawType = account.accountType || '';
    const include = saved.Include !== undefined && saved.Include !== '' ? saved.Include : (String(rawType).toLowerCase().indexOf('cash') >= 0 || String(name).toLowerCase() === 'cash' ? 'FALSE' : 'TRUE');
    const balance = account.balance && account.balance.value !== undefined ? account.balance.value : (account.currentBalance && account.currentBalance.value !== undefined ? account.currentBalance.value : '');
    const comment = saved.Comment || (String(rawType).toLowerCase().indexOf('cash') >= 0 || String(name).toLowerCase() === 'cash' ? 'Cash balance should not be included, Include column must be user set.' : '');
    return [name, currency, include, rawType, balance, comment, id];
  }).sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
  replaceSheetData(getSheet(SHEETS.ACCOUNTS), HEADERS.Accounts, rows);
  applyAccountsFormatting(getSheet(SHEETS.ACCOUNTS), rows.length);
}

function applyAccountsFormatting(sheet, rowCount) {
  const rows = Math.max(rowCount, 1);
  sheet.showColumns(1, Math.min(sheet.getMaxColumns(), HEADERS.Accounts.length));
  sheet.hideColumns(7, 1);
  sheet.getRange(1, 1, 1, HEADERS.Accounts.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#444444');
  sheet.getRange(2, 1, rows, 6).setBackground('#ffffff');
  applyBooleanValidation(sheet, [3]);
  formatMoneyColumns(sheet, [5]);
  recreateFilter(sheet, HEADERS.Accounts.length);
  sheet.autoResizeColumns(1, 6);
}

function writeTransactionsSheet(records) {
  const rows = records.map(function (record) {
    return [record.recordId, record.date, record.month, record.accountId, record.account, record.categoryId, record.category, record.type, record.amountEur, record.originalAmount, record.originalCurrency, record.note, record.categoryType];
  }).sort(function (a, b) { return String(b[1]).localeCompare(String(a[1])); });
  replaceSheetData(getSheet(SHEETS.TRANSACTIONS), HEADERS.Transactions, rows);
  formatMoneyColumns(getSheet(SHEETS.TRANSACTIONS), [9, 10]);
  setupYesterdayExpensesSheet();
}

function normalizeRecords(records, categoryMap, accountMap, config) {
  return records.map(function (record) {
    const amountInfo = getBudgetBakersRecordAmount(record);
    const signedAmount = Number(amountInfo.amount) || 0;
    const isExpense = String(record.recordType || '').toLowerCase() === 'expense';
    const categoryId = String(record.category && record.category.id ? record.category.id : '');
    const accountId = String(record.accountId || '');
    const date = parseRecordDate(record);
    const amountEur = convertAmountToEur(signedAmount, amountInfo.currency, config);
    const missingFxRate = !isFiniteNumber(amountEur);
    const note = record.note || '';
    return {
      recordId: String(record.id || ''),
      date: date ? Utilities.formatDate(date, config.TIMEZONE, 'yyyy-MM-dd') : '',
      month: date ? Utilities.formatDate(date, config.TIMEZONE, 'yyyy-MM') : '',
      accountId: accountId,
      account: record.accountName || (accountMap[accountId] ? accountMap[accountId].name : ''),
      categoryId: categoryId,
      category: categoryMap[categoryId] ? categoryMap[categoryId].fullPath : (record.category && record.category.name ? record.category.name : categoryId),
      type: isExpense ? 'Expense' : 'Income',
      amountEur: missingFxRate ? '' : roundCurrency(Math.abs(amountEur)),
      originalAmount: Math.abs(signedAmount),
      originalCurrency: amountInfo.currency || '',
      note: missingFxRate ? note + ' [Missing FX rate to EUR for ' + amountInfo.currency + ']' : note,
      categoryType: categoryMap[categoryId] ? categoryMap[categoryId].categoryType : ''
    };
  }).filter(function (record) { return record.recordId && record.date; });
}

function getBudgetBakersRecordAmount(record) {
  if (!record.amount || !isFiniteNumber(record.amount.value)) return { amount: 0, source: 'amount.value', currency: '' };
  return { amount: Number(record.amount.value), source: 'amount.value', currency: record.amount.currencyCode || '' };
}

function convertAmountToEur(amount, currency, config) {
  const sourceCurrency = String(currency || config.CURRENCY || 'EUR').toUpperCase();
  if (sourceCurrency === 'EUR') return Number(amount);
  let rates = {};
  try {
    rates = JSON.parse(config.FX_RATES_TO_EUR_JSON || '{"EUR":1}');
  } catch (error) {
    rates = { EUR: 1 };
  }
  const rate = Number(rates[sourceCurrency]);
  if (!isFiniteNumber(rate)) return NaN;
  return Number(amount) * rate;
}

function buildCategoryMap(categories) {
  const raw = {};
  categories.forEach(function (category) {
    const id = getCategoryId(category);
    raw[id] = { id: id, parentId: getParentCategoryId(category), name: getCategoryName(category), categoryType: category.group && category.group.name ? category.group.name : '', raw: category };
  });
  const memo = {};
  function pathFor(id, seen) {
    if (memo[id]) return memo[id];
    const node = raw[id];
    if (!node) return '';
    seen = seen || {};
    if (seen[id]) return node.name;
    seen[id] = true;
    const parentPath = node.parentId && raw[node.parentId] ? pathFor(node.parentId, seen) : '';
    memo[id] = parentPath ? parentPath + ' > ' + node.name : node.name;
    return memo[id];
  }
  Object.keys(raw).forEach(function (id) { raw[id].fullPath = pathFor(id); });
  return raw;
}

function buildAccountMap(accounts) {
  const map = {};
  accounts.forEach(function (account) {
    const id = getAccountId(account);
    const currency = account.balance && account.balance.currencyCode ? account.balance.currencyCode : (account.initialBalance && account.initialBalance.currencyCode ? account.initialBalance.currencyCode : '');
    map[id] = { id: id, name: account.name || '', currency: currency };
  });
  return map;
}

function getConfig() {
  const settings = readKeyValueSheet(getSheet(SHEETS.SETTINGS));
  const props = PropertiesService.getScriptProperties();
  return Object.assign({}, CONFIG_DEFAULTS, settings, {
    WHATSAPP_API_VERSION: props.getProperty('WHATSAPP_API_VERSION') || settings.WHATSAPP_API_VERSION || 'v25.0',
    WHATSAPP_PHONE_NUMBER_ID: props.getProperty('WHATSAPP_PHONE_NUMBER_ID') || settings.WHATSAPP_PHONE_NUMBER_ID || CONFIG_DEFAULTS.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: props.getProperty('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || settings.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'family-budget-whatsapp-webhook'
  });
}

function getWalletToken() {
  return PropertiesService.getScriptProperties().getProperty('WALLET_API_TOKEN');
}

function assertWalletToken() {
  if (!getWalletToken()) throw new Error('Missing WALLET_API_TOKEN. Add it in Apps Script Project Settings > Script Properties.');
}

function getFetchWindowStart(config) {
  const months = String(config.BASELINE_MONTHS || '2026-05,2026-06').split(',').map(function (m) { return m.trim(); }).filter(Boolean);
  const earliestBaseline = months.sort()[0] || Utilities.formatDate(new Date(), config.TIMEZONE, 'yyyy-MM');
  const currentMonth = Utilities.formatDate(new Date(), config.TIMEZONE, 'yyyy-MM');
  const earliest = earliestBaseline < currentMonth ? earliestBaseline : currentMonth;
  return new Date(earliest + '-01T00:00:00Z');
}

function parseRecordDate(record) {
  const value = record.recordDate;
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function getCategoryId(category) {
  return String(category.id || '');
}

function getParentCategoryId(category) {
  return String(category.parentId || '');
}

function getCategoryName(category) {
  return category.name || 'Uncategorized';
}

function getAccountId(account) {
  return String(account.id || '');
}

function getSheet(name) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet: ' + name);
  return sheet;
}

function getSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const configuredId = props.getProperty('SPREADSHEET_ID');
  if (configuredId) return SpreadsheetApp.openById(configuredId);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty('SPREADSHEET_ID', active.getId());
    return active;
  }

  const ss = SpreadsheetApp.create(CONFIG_DEFAULTS.SPREADSHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('SPREADSHEET_URL', ss.getUrl());
  return ss;
}

function replaceSheetData(sheet, headers, rows) {
  ensureSheetColumnCapacity(sheet, headers.length);
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  sheet.clearContents();
  sheet.clearFormats();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function ensureSheetColumnCapacity(sheet, requiredColumns) {
  const missingColumns = requiredColumns - sheet.getMaxColumns();
  if (missingColumns > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
}

function readObjects(sheetName) {
  const sheet = getSheet(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(function (row) { return row.some(function (cell) { return cell !== ''; }); }).map(function (row) {
    const obj = {};
    headers.forEach(function (header, index) { obj[header] = row[index]; });
    return obj;
  });
}

function readKeyValueSheet(sheet) {
  const values = sheet.getDataRange().getValues();
  const map = {};
  values.slice(1).forEach(function (row) {
    if (row[0] && row[1] !== '' && row[1] !== 'DO_NOT_PUT_TOKEN_HERE') map[row[0]] = String(row[1]);
  });
  return map;
}

function applyBooleanValidation(sheet, columns) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).setAllowInvalid(false).build();
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  columns.forEach(function (column) { sheet.getRange(2, column, maxRows, 1).setDataValidation(rule); });
}

function formatMoneyColumns(sheet, columns) {
  const rows = Math.max(sheet.getLastRow() - 1, 1);
  columns.forEach(function (column) { sheet.getRange(2, column, rows, 1).setNumberFormat('€#,##0.00'); });
}

function recreateFilter(sheet, columnCount) {
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  const rows = Math.max(sheet.getMaxRows(), 2);
  sheet.getRange(1, 1, rows, columnCount).createFilter();
}

function logRun(level, action, message) {
  try {
    getSheet(SHEETS.RUN_LOG).appendRow([new Date(), level, action, message]);
  } catch (error) {
    console.log(level + ' ' + action + ': ' + message);
  }
}

function codedError(code, message, details) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details || {};
  return error;
}

function normalizeError(error, defaultCode) {
  if (error && error.code) return error;
  const normalized = new Error(error && error.message ? error.message : String(error || 'Unknown error'));
  normalized.code = defaultCode || 'ERR_UNKNOWN';
  normalized.details = error && error.details ? error.details : {};
  normalized.stack = error && error.stack ? error.stack : normalized.stack;
  return normalized;
}

function formatErrorDetailForLog(error) {
  const coded = normalizeError(error, 'ERR_UNKNOWN');
  return JSON.stringify({
    code: coded.code,
    message: coded.message,
    details: coded.details || {},
    stack: coded.stack || ''
  }).slice(0, 45000);
}

function buildCodedWhatsAppErrorMessage(error, messageId) {
  const coded = normalizeError(error, 'ERR_UNKNOWN');
  const details = coded.details || {};
  const parts = [
    coded.code + ': ' + coded.message,
    messageId ? 'MessageLog id: ' + messageId : '',
    details.sessionId ? 'Claude session: ' + details.sessionId : '',
    details.requestId ? 'Claude request-id: ' + details.requestId : '',
    details.status ? 'HTTP status: ' + details.status : ''
  ].filter(Boolean);
  return parts.join('\n').slice(0, 3500);
}

function httpStatusToClaudeErrorCode(status) {
  if (status === 401) return 'ERR_CLAUDE_HTTP_401';
  if (status === 403) return 'ERR_CLAUDE_HTTP_403';
  if (status === 413) return 'ERR_CLAUDE_HTTP_413';
  if (status === 429) return 'ERR_CLAUDE_HTTP_429';
  if (status === 500) return 'ERR_CLAUDE_HTTP_500';
  if (status === 504) return 'ERR_CLAUDE_HTTP_504';
  if (status === 529) return 'ERR_CLAUDE_HTTP_529';
  return 'ERR_CLAUDE_HTTP_' + String(status || 'UNKNOWN');
}

function isMcpAuthenticationError(error) {
  const value = JSON.stringify(error || {}).toLowerCase();
  return value.indexOf('mcp') >= 0 && (value.indexOf('auth') >= 0 || value.indexOf('credential') >= 0 || value.indexOf('vault') >= 0);
}

function summarizeClaudeEvents(events) {
  const counts = {};
  (events || []).forEach(function (event) {
    const key = event && event.type ? event.type : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return JSON.stringify(counts).slice(0, 4000);
}

function uniqueValues(values) {
  const seen = {};
  return (values || []).filter(function (value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function byteLength(value) {
  return Utilities.newBlob(String(value || '')).getBytes().length;
}

function settingNote(key) {
  const notes = {
    WALLET_API_BASE_URL: 'BudgetBakers Wallet API base URL.',
    TIMEZONE: 'Ireland timezone for summaries and month grouping.',
    CURRENCY: 'Reporting currency.',
    WHATSAPP_ENABLED: 'TRUE to send the daily Summary tab via WhatsApp Cloud API; FALSE to disable.',
    WHATSAPP_PHONE_NUMBER_ID: 'Meta WhatsApp Cloud API phone number ID for your WhatsApp Business sender number. Not the phone number itself.',
    WHATSAPP_TO_NUMBERS: 'Comma-separated E.164 recipient WhatsApp numbers, e.g. +23057937859,+353... These receive individual messages.',
    WHATSAPP_SUMMARY_TOP_N: 'Number of Summary rows to include in WhatsApp daily summary.',
    SUMMARY_HOUR: 'Daily summary hour in Europe/Dublin.',
    CASHFLOW_CAPTURE_HOUR: 'Monthly account-balance capture hour on the 24th of each budget period. Google triggers run near this hour in the script timezone.',
    INCLUDE_ALL_ACCOUNTS: 'All Wallet accounts included by default.',
    FX_RATES_TO_EUR_JSON: 'Hardcoded currency conversion rates to EUR, e.g. {"EUR":1,"ZAR":0.05}. BB records expose amount.value plus amount.currencyCode only.',
    DEFAULT_REPORT_TOP_N: 'Initial Report=TRUE for top N categories by baseline spend.',
    BUDGET_MONTH_START_DAY: 'Day of month that starts your budget/reporting month. Default 25 means 25th through 24th inclusive.',
    WHATSAPP_MESSAGE_STALE_SECONDS: 'Maximum age for a WhatsApp inbound message before late replies are suppressed.',
    CLAUDE_POLL_TIMEOUT_SECONDS: 'Maximum seconds to poll a Claude Managed Agent session before returning a coded timeout error.',
    CLAUDE_POLL_INTERVAL_MS: 'Milliseconds between Claude session event polls.',
    CLAUDE_CONTEXT_MAX_BYTES: 'Maximum serialized prompt/context bytes before returning ERR_CLAUDE_CONTEXT_TOO_LARGE.'
  };
  return notes[key] || '';
}

function buildUrl(base, params) {
  const query = Object.keys(params || {}).filter(function (key) { return params[key] !== undefined && params[key] !== null && params[key] !== ''; }).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
  return query ? base + '?' + query : base;
}

function formatDateOnly(date) {
  return Utilities.formatDate(date, getConfig().TIMEZONE, 'yyyy-MM-dd');
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseSheetNumber(value) {
  if (typeof value === 'number') return Number(value) || 0;
  const cleaned = String(value || '').replace(/[^0-9.\-]/g, '');
  return Number(cleaned) || 0;
}

function normalizeSheetMonth(value, timezone) {
  const tz = timezone || CONFIG_DEFAULTS.TIMEZONE;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, tz, 'yyyy-MM');
  }
  const text = String(value || '').trim();
  const match = text.match(/(\d{4})[-\/](\d{1,2})/);
  if (match) return match[1] + '-' + ('0' + match[2]).slice(-2);
  const date = new Date(text);
  if (!isNaN(date.getTime())) return Utilities.formatDate(date, tz, 'yyyy-MM');
  return text;
}

function getLastCompletedExpenseMonths(transactions, count, timezone) {
  const tz = timezone || CONFIG_DEFAULTS.TIMEZONE;
  const currentMonth = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  const monthMap = {};
  transactions.forEach(function (record) {
    if (String(record.Type).trim().toLowerCase() !== 'expense') return;
    const month = normalizeSheetMonth(record.Month, tz);
    if (month && month < currentMonth) monthMap[month] = true;
  });
  const months = Object.keys(monthMap).sort();
  return months.slice(Math.max(months.length - count, 0));
}

function isFiniteNumber(value) {
  return value !== null && value !== '' && value !== undefined && isFinite(Number(value));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
  });
}

