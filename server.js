const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');
const crypto = require('crypto');
const app = express();
const axios = require('axios');

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
      const groupName = event.message.text.replace('!register', '').trim();

      if (groupName) {
        groupRegistry[groupId] = groupName; // 註冊名稱
        return replyMessage(event.replyToken, `群組名稱已成功註冊為：${groupName}`);
      } else {
        return replyMessage(event.replyToken, '請輸入正確的群組名稱，如：!register GroupName');
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
    return replyMessage(event.replyToken, '請先註冊正確的群組名稱，如:!register YourGroupName');
  }
  
  
  try {
    // 下載檔案內容
    const stream = await client.getMessageContent(messageId);

    // 獲取使用者的顯示名稱
    const headers = {
      'Authorization': `Bearer ${config.channelAccessToken}`
    };

    const res = await axios.get(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, { headers });
    
    const userDir = path.join(__dirname, 'downloads', registeredName, res.data.displayName);

    // 確保資料夾存在
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filePath = path.join(userDir, fileName);
    const writable = fs.createWriteStream(filePath);
    
    // 将流写入文件
    stream.pipe(writable);

    writable.on('finish', () => {
      console.log(`文件 ${fileName} 已成功下载至 ${filePath}`);
    });

    writable.on('error', (error) => {
      console.error(`文件下载失败: ${error}`);
    });
  } catch (error) {
    console.error(`文件下载失败: ${error}`);
  }
}

// 回覆訊息函數
function replyMessage(replyToken, message) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.channelAccessToken}`
  };

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