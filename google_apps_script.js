// ============================================================
// Google Apps Script - 粘贴到 Google Sheets 的 Apps Script 编辑器中
// ============================================================
// 使用方法:
// 1. 打开 Google Sheets → 扩展程序 → Apps Script
// 2. 删除默认代码，粘贴本文件的全部内容
// 3. 点击 "部署" → "新部署" → 类型选 "Web 应用"
// 4. "谁可以访问" 选 "任何人"
// 5. 点击 "部署"，复制生成的 URL
// 6. 将该 URL 粘贴到 script.js 的 BACKEND_URL 中
// ============================================================

function doPost(e) {
    try {
        // 从表单的 'data' 字段读取 JSON
        var raw = e.parameter.data;
        var data = JSON.parse(raw);
        var ss = SpreadsheetApp.getActiveSpreadsheet();

        var type = data.type || 'unknown';
        var subjectId = data.subject_id || 'unknown';
        var payload = data.payload || [];

        if (payload.length === 0) {
            return ContentService.createTextOutput(
                JSON.stringify({ status: 'success', message: 'Empty payload' })
            ).setMimeType(ContentService.MimeType.JSON);
        }

        // 使用脚本锁，防止高并发时后一个请求读取到相同的 getLastRow 导致覆盖数据
        var lock = LockService.getScriptLock();
        lock.waitLock(30000); // 等待锁，最长30秒

        try {
            // 获取或创建对应的 Sheet
            var sheet = ss.getSheetByName(type);
            if (!sheet) {
                sheet = ss.insertSheet(type);
            }

            // 如果 Sheet 是空的，先写表头
            if (sheet.getLastRow() === 0) {
                var headers = Object.keys(payload[0]);
                sheet.appendRow(headers);
            }

            // 写入数据行 (使用批量写入，避免超时)
            var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
            var allRows = [];
            for (var i = 0; i < payload.length; i++) {
                var row = headers.map(function (h) {
                    return payload[i][h] !== undefined ? payload[i][h] : '';
                });
                allRows.push(row);
            }
            // 一次性写入所有行，速度比 appendRow 快 100 倍
            if (allRows.length > 0) {
                var lastRow = sheet.getLastRow();
                sheet.getRange(lastRow + 1, 1, allRows.length, headers.length).setValues(allRows);
            }
        } finally {
            // 确保无论如何最后都会强行释放锁
            lock.releaseLock();
        }

        return ContentService.createTextOutput(
            JSON.stringify({
                status: 'success',
                message: 'Saved ' + payload.length + ' rows to sheet: ' + type
            })
        ).setMimeType(ContentService.MimeType.JSON);

    } catch (err) {
        return ContentService.createTextOutput(
            JSON.stringify({ status: 'error', message: err.toString() })
        ).setMimeType(ContentService.MimeType.JSON);
    }
}

// 用于测试连通性的 GET 请求
function doGet(e) {
    return ContentService.createTextOutput(
        JSON.stringify({ status: 'ok', message: 'Google Sheets backend is ready!' })
    ).setMimeType(ContentService.MimeType.JSON);
}
