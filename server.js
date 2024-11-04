const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');
const crypto = require('crypto');
const app = express();
const axios = require('axios');
const exceljs = require('exceljs');


const config = {
  channelAccessToken:'HbE2WH+aV+xOKsJ98fJo07NeWqIhBkqzGUzFn8csmtkEY0Kunr7iQbawiEhzlEW66yA8lGM6cnnh1EY640pgq7Vf+Gh5BrG2kNcDYThGBKDwjkUqwqaLrmStk9ZU72TxhHfh1l3HOgBoplAqxszEXQdB04t89/1O/w1cDnyilFU=',
  channelSecret:'68933b92d819be3d9ca98d8796fdb5ba'
};
// 設定 axios 的 headers
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${config.channelAccessToken}`
};

// 加載 SSL 憑證
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};
const client = new line.Client(config);
// 定義路由
app.get('/', (req, res) => {
  res.send('Hello HTTPS!');
});

// 中间件获取原始请求体
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); }}));

// 用來存儲群組 ID 和群組名稱的對應關係
const groupRegistry = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  // 获取签名
  const signature = req.headers['x-line-signature'];
  console.log('X-Line-Signature:', signature);
  
  // 计算签名
  const hash = crypto.createHmac('sha256', config.channelSecret)
  .update(req.rawBody)
  .digest('base64');


  // 比较签名
  if (hash !== signature) {
    return res.status(401).send('Signature validation failed');
  }
  // 处理每个来自LINE的事件
  Promise
  .all(req.body.events.map(handleEvent))    
  .then((result) => res.json(result))
  .catch((err) => {
      console.error(err);
      res.status(500).end();
  });
});


// 處理每個事件
async function handleEvent(event) {
  if (event.source.type !== 'group') {
    // 忽略非群組的訊息
    console.log('收到非群組的訊息，將忽略');
    return replyMessage(event.replyToken, '此 Bot 僅支援群組檔案備份功能，請將 Bot 添加到群組中。');
  }
  // 只處理消息事件
  if (event.type === 'message') {
    if (event.message.type === 'text' && event.message.text.startsWith('!register')) {
      // 註冊群組名稱
      const groupId = event.source.groupId;
      const registeredName = event.message.text.replace('!register', '').trim();

      if (registeredName) {
        groupRegistry[groupId] = registeredName; // 註冊名稱
        return replyMessage(event.replyToken, `群組名稱已成功註冊為：${registeredName}`);
      } else {
        return replyMessage(event.replyToken, '請輸入正確的群組名稱，如：!register registeredName');
      }
    } else if (['file', 'image', 'video'].includes(event.message.type)) {
      // 檢查檔案上傳事件
      return handleFileUpload(event);
    }
  }
  return Promise.resolve(null);

}
// 處理檔案上傳的邏輯
async function handleFileUpload(event) {
  const messageId = event.message.id;   
  const userId = event.source.userId;  // 获取用户ID
  const groupId = event.source.groupId; // 获取群组ID
  const registeredName = groupRegistry[groupId]; // 获取已注册的群组名称
  const timestamp = new Date(event.timestamp).toISOString();

  let fileName;
  console.log('User ID:', userId);
  if (!userId) {
    console.error('無法獲取用戶ID');
    return;
  }
  if(registeredName){
    // 確定檔案名稱
    if (event.message.type === 'file') {
      fileName = event.message.fileName;  // 获取文件名
      console.log('收到文件消息：', { messageId, fileName });
    } else if (event.message.type === 'image') {
      fileName = `${messageId}.jpg`;  // 对于图片，使用 messageId 作为文件名
      console.log('收到圖片消息：', { messageId });
    } else if (event.message.type === 'video') {
      fileName = `${messageId}.mp4`;  // 对于视频，使用 messageId 作为文件名
      console.log('收到影片消息：', { messageId });
    }
  }else{
    return replyMessage(event.replyToken, '請先註冊正確的群組名稱，如:!register YourregisteredName');
  }
  
  
  try {
    // 下載檔案內容
    const stream = await client.getMessageContent(messageId);

    const res = await axios.get(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, { headers });
    const userName = res.data.displayName;
    const userDir = path.join(__dirname, 'downloads', registeredName, userName);

    // 確保資料夾存在
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filePath = path.join(userDir, fileName);
    const writable = fs.createWriteStream(filePath);
    
    // 将流写入文件
    stream.pipe(writable);

    writable.on('finish', async () => {
      console.log(`文件 ${fileName} 已成功下载至 ${filePath}`);
      await addRecordToExcel(registeredName, userName, timestamp, filePath);
    });

    writable.on('error', (error) => {
      console.error(`文件下载失败: ${error}`);
    });
  } catch (error) {
    console.error(`文件下载失败: ${error}`);
  }
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0'); // 月份從 0 開始，所以加 1
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function addRecordToExcel(registeredName, userName, timestamp, filePath) {
  const formattedTimestamp = formatTimestamp(timestamp);
  const excelPath = path.join(__dirname, 'downloads', `已上傳的檔案們.xlsx`);
  const workbook = new exceljs.Workbook();
  let worksheet;

  try{

    if (fs.existsSync(excelPath)) {
      await workbook.xlsx.readFile(excelPath);// 讀取現有文件
      worksheet = workbook.getWorksheet('Records');
    } else {
  
      worksheet = workbook.addWorksheet('Records');// 創建新工作表
      worksheet.columns = [
        { header: '上傳者', key: 'uploader', width: 20 },
        { header: '上傳時間', key: 'timestamp', width: 30 },
        { header: '檔案路徑', key: 'filePath', width: 50 },
        { header: '群組名稱', key: 'groupName', width: 30 }
      ];
    }
    // 新增資料行
    const newRow = worksheet.addRow([
      userName,
      formattedTimestamp,
      { text: '開啟檔案', hyperlink: `file://${filePath}` },
      registeredName
    ]);
    console.log('新增行:', newRow.values);

    // 保存文件
    await workbook.xlsx.writeFile(excelPath);

    // 重新讀取以驗證
    const verifyWorkbook = new exceljs.Workbook();
    await verifyWorkbook.xlsx.readFile(excelPath);
    const verifyWorksheet = verifyWorkbook.getWorksheet('Records');
    console.log(`文件保存成功。當前記錄行數: ${verifyWorksheet.rowCount}`);
    verifyWorksheet.eachRow((row, rowNumber) => {
      console.log(`Row ${rowNumber}:`, row.values);
    });

  } catch (error) {
    console.error('寫入 Excel 時發生錯誤:', error);
  }
  
}

// 回覆訊息函數
function replyMessage(replyToken, message) {

  const body = {
    replyToken: replyToken,
    messages: [
      {
        type: 'text',
        text: message
      }
    ]
  };

  axios.post('https://api.line.me/v2/bot/message/reply', body, { headers })
    .then(() => {
      console.log('Reply message sent successfully');
    })
    .catch(error => {
      console.error('Error sending reply message:', error);
    });
}
// 建立 HTTPS 伺服器
https.createServer(sslOptions, app).listen(23457, () => {
  console.log('HTTPS server running on port 23457');
});