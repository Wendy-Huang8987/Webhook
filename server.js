const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');
const crypto = require('crypto');
const app = express();

const config = {
  channelAccessToken:'HbE2WH+aV+xOKsJ98fJo07NeWqIhBkqzGUzFn8csmtkEY0Kunr7iQbawiEhzlEW66yA8lGM6cnnh1EY640pgq7Vf+Gh5BrG2kNcDYThGBKDwjkUqwqaLrmStk9ZU72TxhHfh1l3HOgBoplAqxszEXQdB04t89/1O/w1cDnyilFU=',
  channelSecret:'68933b92d819be3d9ca98d8796fdb5ba'
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
  // 只處理檔案上傳的消息事件
  if (event.type === 'message') {
    if (event.message.type === 'file') {
      return handleFileUpload(event, 'file');
    } else if (event.message.type === 'image') {
      return handleFileUpload(event, 'image');
    } else if (event.message.type === 'video') {
      return handleFileUpload(event, 'video');  // 增加视频消息处理
    }
  }
  return Promise.resolve(null);

}
// 處理檔案上傳的邏輯
async function handleFileUpload(event, type) {
  const messageId = event.message.id;   
  const userId = event.source.userId;  // 获取用户ID
  let fileName;

  if (!userId) {
    console.error('无法获取用户ID');
    return;
  }

  if (type === 'file') {
    fileName = event.message.fileName;  // 获取文件名
    console.log('收到文件消息：', { messageId, fileName });

    if (!fileName) {
      console.error('文件名称不存在！');
      return;
    }
  } else if (type === 'image') {
    fileName = `${messageId}.jpg`;  // 对于图片，使用 messageId 作为文件名
    console.log('收到图片消息：', { messageId });
  } else if (type === 'video') {
    fileName = `${messageId}.mp4`;  // 对于视频，使用 messageId 作为文件名，假设是 mp4 格式
    console.log('收到视频消息：', { messageId });
  }
  
  try {
    let userprofile = await client.getProfile(userId);
    const stream = await client.getMessageContent(messageId);
    
    const userDir = path.join(__dirname, 'downloads', userprofile.displayName);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filePath = path.join(userDir, fileName);
    
    const writable = fs.createWriteStream(filePath);
    stream.pipe(writable);

    console.log(`文件 ${fileName} 已成功下载至 ${filePath}`);
  } catch (error) {
    console.error(`文件下载失败: ${error}`);
  }
}


// 建立 HTTPS 伺服器
https.createServer(sslOptions, app).listen(23457, () => {
  console.log('HTTPS server running on port 23457');
});