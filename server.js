const express = require('express');
const { MongoClient } = require('mongodb');
const https = require('https');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');
const crypto = require('crypto');
const app = express();
const axios = require('axios');
const exceljs = require('exceljs');


const mongoUri = 'mongodb://localhost:27017'; // 替換為你的 MongoDB 連接字串
const mongoClient = new MongoClient(mongoUri);

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
  await mongoClient.connect();
  const db = mongoClient.db("LineCopy");
  const collection = db.collection("groupName");
  if (event.source.type !== 'group') {
    // 忽略非群組的訊息
    console.log('收到非群組的訊息，將忽略');
    return replyMessage(event.replyToken, '此 Bot 僅支援群組檔案備份功能，請將 Bot 添加到群組中。');
  }
  // 只處理消息事件
  if (event.type === 'message') {
    // 檢查群組ID是否已註冊
    const groupId = event.source.groupId;
    const existingGroupWithId = await collection.findOne({ groupId: groupId });
    if(existingGroupWithId){
      groupRegistry[existingGroupWithId.groupId] = existingGroupWithId.groupName;
    }

    if (event.message.type === 'text' && event.message.text.startsWith('#G')) {
      // 註冊群組名稱
      const registeredName = event.message.text.replace('#G', '').trim();
      if (registeredName) {
        return registerGroupName(groupId, registeredName, event.replyToken);
      } else {
        return replyMessage(event.replyToken, '請輸入正確的群組名稱，如：#G registeredName');
      }
      
    } else if (['file', 'image', 'video'].includes(event.message.type)) {
      // 檢查檔案上傳事件
      return handleFileUpload(event);
    }

    // if(event.message.type === 'text'){
    //   if (event.message.text === '查找') {
    //     console.log("???")
    //     // 確認這是一個回覆訊息並提取被回覆的訊息
    //     const repliedMessage = event.message.repliedMessage;
        
    //     if (repliedMessage && repliedMessage.text) {
    //       // 提取被回覆的檔案名稱
    //       const fileName = repliedMessage.text;
    //       console.log(fileName);
    //     }
    //   }
    // }
  }
  return Promise.resolve(null);

}
// 註冊群組名稱
async function registerGroupName(groupId, groupName, replyToken) {
  try {
    await mongoClient.connect();
    const db = mongoClient.db("LineCopy");
    const collection = db.collection("groupName");

    const existingGroupWithName = await collection.findOne({ groupName: groupName });
    if (existingGroupWithName) {
      // 檢查群組名稱是否已被使用
      return replyMessage(replyToken, `群組名稱「${groupName}」已被其他群組使用，請選擇其他名稱。`);
    }else{
      groupRegistry[groupId] = groupName; // 註冊名稱
      // 新註冊
      await collection.insertOne({ groupId: groupId, groupName: groupName,createTime:new Date().toLocaleDateString() });
      return replyMessage(replyToken, `群組名稱已成功註冊為：${groupName}`);
    }
  } catch (error) {
    console.error('註冊群組名稱時發生錯誤:', error);
    return replyMessage(replyToken, '註冊失敗，請稍後再試。');
  } finally {
    await mongoClient.close();
  }
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
  

  if (!userId || !registeredName) {
    return replyMessage(event.replyToken, '請先註冊正確的群組名稱，如:#G YourregisteredName');
  }


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

    // Save record to MongoDB
    await savefilerecord({
      filePath: filePath,
      groupName: registeredName,
      timestamp: formatTimestamp(timestamp),
      uploader: userName,
    });

      //await addRecordToExcel(registeredName, userName, timestamp, filePath);
    });

    writable.on('error', (error) => {
      console.error(`文件下载失败: ${error}`);
    });
  } catch (error) {
    console.error(`文件下载失败: ${error}`);
  }
}
async function savefilerecord(record) {
  try {
    await mongoClient.connect();
    const database = mongoClient.db('LineCopy');
    const collection = database.collection('fileRecords');

    const result = await collection.insertOne(record);
    console.log(`成功存入 MongoDB，_id: ${result.insertedId}`);
  } catch (error) {
    console.error('存入 MongoDB 時出錯:', error);
  } finally {
    await mongoClient.close();
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

async function generateExcelFromMongoDB() {
  const excelPath = path.join(__dirname, 'downloads', '已上傳的檔案們.xlsx');
  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet('Records');

  worksheet.columns = [
    { header: '檔案路徑', key: 'filePath', width: 20 },
    { header: '群組名稱', key: 'groupName', width: 30 },
    { header: '上傳時間', key: 'timestamp', width: 30 },
    { header: '上傳者', key: 'uploader', width: 20 }
  ];

  try {
    await mongoClient.connect();
    const database = mongoClient.db('LineCopy');
    const collection = database.collection('fileRecords');

    const records = await collection.find().toArray();
    console.log(records)
    records.forEach(record => {
      worksheet.addRow([
        { text: '開啟檔案', hyperlink: `file://${record.filePath}` },
        record.groupName,
        formatTimestamp(record.timestamp),
        record.uploader
      ]);
    });

    await workbook.xlsx.writeFile(excelPath);
    console.log('Excel 文件已生成並保存至:', excelPath);
  } catch (error) {
    console.error('生成 Excel 文件時出錯:', error);
  } finally {
    await mongoClient.close();
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

// 每分鐘執行一次
setInterval(() => {
  console.log('開始更新 Excel 報表...');
  generateExcelFromMongoDB()
    .then(() => {
      console.log('Excel 報表更新完成。');
    })
    .catch(err => {
      console.error('更新 Excel 報表時發生錯誤:', err);
    });
}, 60 * 1000); // 60 秒 = 1 分鐘