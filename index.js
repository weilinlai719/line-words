'use strict';

/*==================================
 BASIC REQUIRE
====================================*/
const line = require('@line/bot-sdk');
const express = require('express');
const path = require('path');
const HTMLParser = require('node-html-parser');
const https = require('https');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const fs = require('fs');
const cors = require('cors'); // 💡 新增：引入跨網域套件

// --- 新增：Google Sheets 初始化套件 ---
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secret,
};

/*==================================
 GOOGLE SHEETS 授權設定
====================================*/
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') : '',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 原本的單字本 Sheet
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

// 💡 新增：讀取你指定的 process.env.Google_post_id 試算表
const postDoc = new GoogleSpreadsheet(process.env.Google_post_id, serviceAccountAuth);

/*==================================
 CUSTOM REQUIRE AND INIT
====================================*/
const client = new line.Client(config);
const app = express();

// 💡 新增：全域啟用 CORS，允許你的 GitHub Pages 前端網頁發送請求
app.use(cors({
  origin: '*', // 測試成功後，可改成你的 GitHub 網址如 'https://你的帳號.github.io' 提高安全性
methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

const words = require('./words.json');
const words_advance = require('./words-advance.json');
let echo = { type: 'text', text: '請從選單進行操作 ⬇️\n或是輸入/ai問問AI' };

const dirs = ['./user_question', './user_words', './users'];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

/*==================================
 APP REQUEST ACTIONS
====================================*/
app.use('/audio/', express.static('./audio/'));
app.use('/video/', express.static('./video/'));

app.get('/', (req, res) => {
  let html = `<html><head><title>高中7000單</title><script>window.location = "https://lin.ee/BH9lDv7";</script></head><body style="text-align:center"><h1>自動跳轉中⋯⋯</h1></body></html>`;
  res.send(html);
});

// LINE Bot Webhook (保持原樣，不受 express.json() 干擾)
app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

/*==================================
 🚀 全新擴充：論壇貼文與留言系統 API
====================================*/
// 1. 【更新：支援圖片寫入】新增貼文
app.post('/api/post', express.json(), async (req, res) => {
  try {
    const { name, content, image } = req.body; // 💡 接收前端傳來的圖片網址
    if (!name || !content) {
      return res.status(400).json({ success: false, error: '署名與內文不可為空' });
    }

    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const maxId = rows.reduce((max, row) => {
      const id = parseInt(row.get('編號')) || 0;
      return id > max ? id : max;
    }, 0);
    const nextId = maxId + 1;

    // 寫入雲端試算表 (對應加上 圖片 欄位)
    await sheet.addRow({
      '編號': nextId,
      '署名': name,
      '內文': content,
      '時間': new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      '圖片': image || '' ,
      'hashtag': hashtag || '' ,
      // 💡 寫入試算表
    });

    return res.status(200).json({ success: true, id: nextId, message: '文章發布成功！' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 【更新：支援圖片讀取】依據編號，取得單一貼文
app.get('/api/post/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const targetRow = rows.find(r => r.get('編號') == postId);
    if (!targetRow) {
      return res.status(404).json({ success: false, error: '找不到該編號的文章' });
    }

    return res.status(200).json({
      success: true,
      post: {
        id: targetRow.get('編號'),
        name: targetRow.get('署名'),
        content: targetRow.get('內文'),
        time: targetRow.get('時間'),
        image: targetRow.get('圖片') // 💡 回傳圖片網址
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. 【更新：支援圖片列表】撈取所有文章列表
app.get('/api/posts', async (req, res) => {
  try {
    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const posts = rows.map(r => ({
      id: r.get('編號'),
      name: r.get('署名'),
      content: r.get('內文'),
      time: r.get('時間'),
      image: r.get('圖片'),
      hashtag: r.get('hashtag') // 💡 讓列表頁面也能讀取到圖片網址
    }));
    return res.status(200).json({ success: true, posts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 🚀 全新擴充：修改貼文 API (PUT)
// ==========================================
app.put('/api/post/:id', express.json(), async (req, res) => {
  try {
    const postId = req.params.id;
    const { name, content, image, hashtag } = req.body;

    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const targetRow = rows.find(r => r.get('編號') == postId);
    if (!targetRow) {
      return res.status(404).json({ success: false, error: '找不到該文章，無法修改' });
    }

    // 更新 Google Sheets 資料
    targetRow.set('署名', name);
    targetRow.set('內文', content);
    targetRow.set('圖片', image || '');
    targetRow.set('hashtag', hashtag || ''); 
    await targetRow.save(); // 儲存變更

    return res.status(200).json({ success: true, message: '文章修改成功！' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 🚀 全新擴充：刪除貼文 API (DELETE)
// ==========================================
app.delete('/api/post/:id', async (req, res) => {
  try {
    const postId = req.params.id;

    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const targetRow = rows.find(r => r.get('編號') == postId);
    if (!targetRow) {
      return res.status(404).json({ success: false, error: '找不到該文章，無法刪除' });
    }

    await targetRow.delete(); // 從 Google Sheets 中刪除該列

    return res.status(200).json({ success: true, message: '文章刪除成功！' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 【comment】新增留言：針對特定文章編號留言，寫入「留言」分頁
app.post('/api/comment', express.json(), async (req, res) => {
  try {
    const { postId, name, content } = req.body; // 文章編號、署名、內文
    if (!postId || !name || !content) {
      return res.status(400).json({ success: false, error: '參數缺少，無法留言' });
    }

    await postDoc.loadInfo();
    // 尋找名稱為「留言」的工作表分頁
    const sheet = postDoc.sheetsByTitle['comment'] || postDoc.sheetsByIndex[1];
    if (!sheet) {
      return res.status(404).json({ success: false, error: '找不到「留言」分頁，請先在試算表建立該工作表' });
    }

    await sheet.addRow({
      '文章編號': postId,
      '署名': name,
      '內文': content,
      '時間': new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    });

    return res.status(200).json({ success: true, message: '留言成功！' });
  } catch (err) {
    console.error('新增留言失敗:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 【get_post_num】取得目前共有幾則貼文
app.get('/api/posts/count', async (req, res) => {
  try {
    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    return res.status(200).json({ success: true, count: rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 【get_comment】依據文章編號，撈取底下的所有留言
app.get('/api/post/:id/comments', async (req, res) => {
  try {
    const postId = req.params.id;
    await postDoc.loadInfo();
    const sheet = postDoc.sheetsByTitle['留言'] || postDoc.sheetsByIndex[1];
    if (!sheet) {
      return res.status(200).json({ success: true, comments: [] });
    }

    const rows = await sheet.getRows();
    // 過濾出文章編號相符的留言
    const filteredComments = rows
      .filter(r => r.get('文章編號') == postId)
      .map(r => ({
        name: r.get('署名'),
        content: r.get('內文'),
        time: r.get('時間')
      }));

    return res.status(200).json({ success: true, comments: filteredComments });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/*==================================
 APP ROUTER
====================================*/
function handleEvent(event) {
  if (event.type === 'message') {
    return handleMessageEvent(event);
  } else if (event.type === 'postback') {
    return handlePostbackEvent(event);
  } else {
    return Promise.resolve(null);
  }
}

function handleMessageEvent(event) {
  const text = event.message.text?.trim();
   if (text && text.startsWith('/ai')) {
    const prompt = text.replace('/ai', '').trim();
    return callAI(event, prompt);
  }
  switch (event.message.text) {
    case '開始測驗':
      return client.replyMessage(event.replyToken, [createQuestionType()]);
    case '我的字庫':
      return createUserCollection(event);
    case '得分':
      return handleUserPoints(event); 
    default:
  let user = event.source.userId;
  let qPath = __dirname + `/user_question/${user}.json`;

  if (fs.existsSync(qPath)) {
    return handleAudioAnswer(event);
  }
  if (/[a-zA-Z]/.test(event.message.text)) {
    return queryWord(event, event.message.text);
  }

  return client.replyMessage(event.replyToken, echo);
  }
}

function handlePostbackEvent(event) {
  const postback_result = handleUrlParams(event.postback.data);
  switch (postback_result.type) {
    case 'question_type':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type)]);
    case 'answer':
      let isCorrect = handleAnswer(event.postback.data);
      if (isCorrect) {
        updateUserPoints(event); 
        return client.replyMessage(event.replyToken, moreQuestion(postback_result.question_type, postback_result.wid, true));
      } else {
        updateUserWrongAnswer(event); 
        return client.replyMessage(event.replyToken, moreQuestion(postback_result.question_type, postback_result.wid, false));
      }
    case 'play_pronounce':
      return playPronounce(event, postback_result.wid);
    case 'more_question':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type, postback_result.wid)]);
    case 'more_test':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type)]);
    case 'add_to_collection':
      return addToUserCollection(event, postback_result.wid);
    case 'delete_from_my_collection':
      return deleteFromMyCollection(event, postback_result.wid);
    case 'check_my_collection':
      return createUserCollection(event);
    case 'check_word':
      return checkWord(event, postback_result.wid);
    default:
      return client.replyMessage(event.replyToken, echo);
  }
}

/*==================================
 GOOGLE SHEETS 關鍵函數 (雲端化核心)
====================================*/

async function handleUserPoints(event) {
  const userId = event.source.userId;
  console.log('正在嘗試幫用戶加分，ID:', userId);
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const userRow = rows.find(r => r.get('userId') === userId);

    if (userRow) {
      console.log('找到用戶，目前分數:', userRow.get('point'));
      const userData = {
        user: userId,
        point: parseInt(userRow.get('point')) || 0,
        wrong_answer: parseInt(userRow.get('wrong_answer')) || 0
      };
      return client.replyMessage(event.replyToken, createPointMessage(userData));
    } else {
      console.log('找不到用戶，建立新欄位');
      await sheet.addRow({ userId: userId, point: 0, wrong_answer: 0 });
      return client.replyMessage(event.replyToken, { type: 'text', text: "找不到用戶，開始挑戰吧" });
    }
  } catch (err) { console.error('Sheet Read Error:', err); }
}

async function updateUserPoints(event) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    let userRow = rows.find(r => r.get('userId') === userId);
    if (userRow) {
      userRow.set('point', (parseInt(userRow.get('point')) || 0) + 1);
      await userRow.save();
    } else {
       await sheet.addRow({ userId: userId, point: 1, wrong_answer: 0 });
    }
  } catch (err) { console.error('Sheet Update Error:', err); }
}

async function updateUserWrongAnswer(event) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    let userRow = rows.find(r => r.get('userId') === userId);

    if (userRow) {
      userRow.set('wrong_answer', (parseInt(userRow.get('wrong_answer')) || 0) + 1);
      await userRow.save();
    } else {
      await sheet.addRow({ user: userId, point: 0, wrong_answer: 1 });
    }
  } catch (err) { console.error('Sheet Update Error:', err); }
}

/*==================================
 APP FUNCTIONS 
====================================*/
const axios = require('axios');
const { translate } = require('google-translate-api-x');
async function queryWord(event, input) {
  const word = input.trim().toLowerCase();
  const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

  try {
    const response = await axios.get(dictUrl);
    const data = response.data[0];
    const phonetic = data.phonetic || data.phonetics?.find(p => p.text)?.text || "";

    let rawEnglishList = []; // 用來放純英文，準備一次翻譯
    let structure = []; // 用來紀錄結構

    // 1. 先整理所有英文定義與例句
    data.meanings.forEach((m) => {
      structure.push({ type: 'partOfSpeech', text: `\n【${m.partOfSpeech.toUpperCase()}】` });
      m.definitions.forEach((d, i) => {
        structure.push({ type: 'definition', en: `${i + 1}. ${d.definition}` });
        rawEnglishList.push(d.definition); // 放入批次翻譯清單
        
        if (d.example) {
          structure.push({ type: 'example', en: `   Ex: ${d.example}` });
          rawEnglishList.push(d.example); // 放入批次翻譯清單
        }
      });
    });

    // 2. 執行「批次翻譯」 (用特殊符號隔開，避免 Google 把句子合在一起)
    const bigEnString = rawEnglishList.join(' \n### ');
    const resTranslation = await translate(bigEnString, { to: 'zh-TW' });
    const translatedList = resTranslation.text.split('###').map(s => s.trim());

    // 3. 把翻譯好的中文塞回結構中
    let transIndex = 0;
    let finalLines = [
      `📖 單字查詢：${word.toUpperCase()}`,
      `音標：${phonetic}`,
      `----------------------`
    ];

    structure.forEach(item => {
      if (item.type === 'partOfSpeech') {
        finalLines.push(item.text);
      } else if (item.type === 'definition') {
        finalLines.push(item.en);
        finalLines.push(`   釋義：${translatedList[transIndex++] || ""}`);
      } else if (item.type === 'example') {
        finalLines.push(item.en);
        finalLines.push(`   例：${translatedList[transIndex++] || ""}`);
      }
    });

    const replyText = finalLines.join('\n');

    // 4. 分段邏輯
    const MAX_LENGTH = 4900;
    const messages = [];
    for (let i = 0; i < replyText.length; i += MAX_LENGTH) {
      messages.push({
        type: "text",
        text: replyText.substring(i, i + MAX_LENGTH)
      });
    }

    await client.replyMessage(event.replyToken, messages.slice(0, 5));

  } catch (error) {
  try {
      // 判斷是否為空字串
      if (!word) return;

      const resTranslation = await translate(word, { to: 'zh-TW' });
      const translatedText = resTranslation.text;

      const replyText = [
        `${word}`,
        `----------------------`,
        `${translatedText}`
      ].join('\n');

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText
      });

    } catch (transError) {
      console.error("Translation Error:", transError);
      client.replyMessage(event.replyToken, { 
        type: "text", 
        text: "抱歉，目前無法查詢單字也無法進行翻譯。" 
      });
    }
  
  }
}
async function callAI(event, prompt) {
  if (!prompt) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "請在 /ai 後面輸入內容"
    });
  }

  const userId = event.source.userId;

  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['ai_memory'];
    const rows = await sheet.getRows();
    const safeRows = Array.isArray(rows) ? rows : [];

    let userHistory = [];
    if (safeRows.length > 0) {
      userHistory = safeRows.filter(r => {
        try {
          return r.get('userId') === userId;
        } catch (e) {
          return false;
        }
      }).slice(-10);
    }

    let aiMessages = [{ role: "system", content: "你是友善的line應用程式英語教練,使用英語與中文回答問題。" }];

    if (userHistory.length > 0) {
      userHistory.forEach(row => {
        aiMessages.push({ role: row.get('role'), content: row.get('content') });
      });
    }
    aiMessages.push({ role: "user", content: prompt });

    const postData = JSON.stringify({
      model: "gemini-2.5-flash",
      messages: aiMessages,
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: "/v1beta/openai/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GEMINI_API_KEY
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", async () => {
          try {
            const json = JSON.parse(data);
            if (json.error) throw new Error(json.error.message);
            
            const replyText = json.choices[0].message.content.trim();
            await sheet.addRow({
              userId: userId,
              role: "user",
              content: prompt,
              time: new Date().toLocaleString()
            });
            await sheet.addRow({
              userId: userId,
              role: "assistant",
              content: replyText,
              time: new Date().toLocaleString()
            });
            const MAX_LENGTH = 4900;
            const messages = [];
            
            for (let i = 0; i < replyText.length; i += MAX_LENGTH) {
              messages.push({
                type: "text",
                text: replyText.substring(i, i + MAX_LENGTH)
              });
            }
            await client.replyMessage(event.replyToken, messages.slice(0, 5));
            
            resolve();
          } catch (err) {
            console.error("AI Error:", err);
            client.replyMessage(event.replyToken, { type: "text", text: "教練現在有點忙，請稍後再試。" });
            resolve(); 
          }
        });
      });

      req.on("error", (err) => { 
        console.error("Request Error:", err);
        resolve(); 
      });
      req.write(postData);
      req.end();
    });

  } catch (err) {
    console.error('Sheet Memory Error:', err);
    return client.replyMessage(event.replyToken, { type: "text", text: "記憶讀取失敗" });
  }
}


function createQuestionType() {
  return {
    "type": "flex", "altText": "考試開始，不要作弊！",
    "contents": {
      "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md",
        "contents": [
          { "type": "button", "action": { "type": "postback", "label": "英文出題", "data": "wid=&type=question_type&question_type=english&content=english" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "中文出題", "data": "wid=&type=question_type&question_type=chinese&content=chinese" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "發音出題", "data": "wid=&type=question_type&question_type=audio&content=audio" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "英文出題 (高階)", "data": "wid=&type=question_type&question_type=english_advance&content=english_advance" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "中文出題 (高階)", "data": "wid=&type=question_type&question_type=chinese_advance&content=chinese_advance" }, "style": "secondary" }
        ]
      }
    }
  };
}

function createQuestion(event, question_type, current_wid = null) {
  if (question_type == 'audio') return createAudioQuestion(event, question_type, current_wid);
  let new_words = (question_type == 'english_advance' || question_type == 'chinese_advance') ? words_advance : words;
  if (current_wid !== null) {
    let index = getObjectItemIndex(words, current_wid);
    if (index !== -1) new_words = removeByIndex(new_words, index);
  }
  let w = new_words[Math.floor(Math.random() * new_words.length)];
  let contents = [];
  let question = (question_type == 'english' || question_type == 'english_advance') ? (w.word).replace(/(\w+)\s(\(\w+\.\))/g, "$1") : w.translate;
  contents.push({ "type": "text", "text": `${question}\n`, "size": "xxl", "wrap": true });
  let answers = createAnswers(question_type, w.id);
  answers.push(w);
  answers.sort(() => Math.random() - 0.5);
  for (let i = 0; i < answers.length; i++) {
    let temp_answer = (question_type == 'english' || question_type == 'english_advance') ? answers[i].translate : answers[i].word;
    contents.push({ "type": "button", "action": { "type": "postback", "label": (temp_answer).replace(/(\w+)\s(\(\w+\.\))/g, "$1"), "data": `wid=${w.id}&type=answer&question_type=${question_type}&content=${temp_answer}` }, "style": "secondary" });
  }
  return { "type": "flex", "altText": "考試開始，不要作弊！", "contents": { "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": contents } } };
}

function createAudioQuestion(event, question_type, current_wid = null) {
  let new_words = words;
  if (current_wid !== null) {
    let index = getObjectItemIndex(words, current_wid);
    if (index !== -1) new_words = removeByIndex(new_words, index);
  }
  let w = new_words[Math.floor(Math.random() * new_words.length)];
  let user = event.source.userId;
  let path = __dirname + `/user_question/${user}.json`;
  fs.writeFileSync(path, JSON.stringify([w]));
  return { "type": "flex", "altText": "考試開始，不要作弊！", "contents": { "type": "bubble", 
    "hero": { "type": "video", "url": `https://words7000.unlink.men/video/${w.id}.mp4`, "previewUrl": "https://words7000.unlink.men/audio/cover.png", "aspectRatio": "16:9" },
    "body": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "wrap": true, "text": "請點擊影片聽取音檔\n並輸入答案後送出" }] } } };
}

function createAnswers(question_type, wid, total = 3) {
  let object = [];
  let new_words = (question_type == 'english_advance' || question_type == 'chinese_advance') ? [...words_advance] : [...words];
  let index = getObjectItemIndex(new_words, wid);
  if (index !== -1) new_words.splice(index, 1);
  if (question_type.includes('advance')) total = 5;
  for (let i = 0; i < total; i++) {
    let rand = Math.floor(Math.random() * new_words.length);
    object.push(new_words.splice(rand, 1)[0]);
  }
  return object;
}

function moreQuestion(question_type, wid, answer) {
  let w = words.filter(x => x.id == wid);
  let contents = [];
  contents.push({ "type": "text", "size": "xl", "color": answer ? "#000000" : "#ff0000", "text": answer ? "恭喜、答對了！！！\n" : "❌ 答錯了！\n" });
  contents.push({ "type": "separator" });
  contents.push({ "type": "text", "wrap": true, "text": `${w[0].word}\n翻譯：${w[0].translate}\n` });
  contents.push({ "type": "button", "action": { "type": "postback", "label": "再來一題", "data": `wid=${wid}&type=more_question&question_type=${question_type}&content=再來一題` }, "style": "primary" });
  contents.push({ "type": "button", "action": { "type": "postback", "label": "聽發音", "data": `wid=${wid}&type=play_pronounce&question_type=${question_type}&content=聽發音` }, "style": "secondary" });
  return { "type": "flex", "altText": "再來一題", "contents": { "type": "bubble", 
    "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": contents },
    "footer": { "type": "box", "layout": "vertical", "contents": [{ "type": "separator" }, { "type": "button", "action": { "type": "postback", "label": "加入字庫", "data": `wid=${wid}&type=add_to_collection&content=加入字庫` } }] } } };
}

function handleAnswer(data) {
  let result = handleUrlParams(data);
  let w = (result.question_type.includes('advance')) ? words_advance.find(x => x.id == result.wid) : words.find(x => x.id == result.wid);
  if (!w) return false;
  if (result.question_type.includes('english')) return result.content == w.translate;
  return result.content == w.word;
}

function handleAudioAnswer(event) {
  let user = event.source.userId;
  let path = __dirname + `/user_question/${user}.json`;
  if (!fs.existsSync(path)) return;
  let user_json = JSON.parse(fs.readFileSync(path));
  let w = user_json[0];
  let answer = w.word.replace(/(\w+)\s.+/g, "$1").replace(/é/g, "e").replace(/[-.]/g, "").toLowerCase();
  let user_answer = event.message.text.replace(/[-.]/g, "").replace(/é/g, "e").toLowerCase();
  fs.unlinkSync(path);
  if (user_answer == answer) {
    updateUserPoints(event);
    return client.replyMessage(event.replyToken, moreQuestion("audio", w.id, true));
  } else {
    updateUserWrongAnswer(event);
    return client.replyMessage(event.replyToken, moreQuestion("audio", w.id, false));
  }
}

function createUserCollection(event) {
  let user = event.source.userId;
  let path = __dirname + `/user_words/${user}.json`;
  if (!fs.existsSync(path)) return client.replyMessage(event.replyToken, { type: "text", text: "您的字庫裡尚無任何單字" });
  let user_json = JSON.parse(fs.readFileSync(path));
  let user_words = user_json[0].words;
  if (user_words.length == 0) return client.replyMessage(event.replyToken, { type: "text", text: "您的字庫裡尚無任何單字" });
  
  let bubble_content = [];
  let box_content = [];
  for (let i = 0; i < user_words.length; i++) {
    box_content.push({ "type": "box", "layout": "horizontal", "spacing": "md", "contents": [
      { "type": "text", "wrap": true, "flex": 5, "text": `${user_words[i].word}\n${user_words[i].translate}` },
      { "type": "button", "flex": 2, "action": { "type": "postback", "label": "查看", "data": `wid=${user_words[i].id}&type=check_word&content=查看` }, "style": "secondary" }
    ]});
    if ((i + 1) < user_words.length && (i + 1) % 7 != 0) box_content.push({ "type": "separator" });
    if ((i + 1) % 7 == 0 || (i + 1) == user_words.length) {
      bubble_content.push({ "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": box_content } });
      box_content = [];
    }
  }
  return client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "我的字庫", "contents": { "type": "carousel", "contents": bubble_content } }]);
}

function checkWord(event, wid) {
  let w = words.find(x => x.id == wid);
  let word = w.word.replace(/é/g, "e").replace(/[-.]/g, "").replace(/(\w+)\s(\(\w+\.?\))/g, "$1");
  if (word == "BBQ") word = "barbecue";
  let url = "https://cdict.info/query/" + encodeURIComponent(word);

  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let root = HTMLParser.parse(data);
      let word_pa = root.querySelector('.resultbox .dictt')?.innerText.replace(/(國際音標)/g, "\n國際音標") || "";
      let word_info = root.querySelector('.resultbox')?.toString().replace(/<br\s*[\/]?>/g, "\n").replace(/<[^>]+>/g, "") || w.translate;
      if (word_info.includes("找不到相關")) word_info = w.translate;

      let body_contents = [];
      if (word_pa) { body_contents.push({ "type": "text", "color": "#999999", "size": "xs", "wrap": true, "text": word_pa }); body_contents.push({ "type": "separator" }); }
      body_contents.push({ "type": "text", "wrap": true, "text": word_info });

      client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "單字詳解", "contents": { "type": "bubble",
        "header": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "size": "xl", "text": word }] },
        "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": body_contents },
        "footer": { "type": "box", "layout": "vertical", "contents": [
          { "type": "button", "action": { "type": "postback", "label": "聽發音", "data": `wid=${wid}&type=play_pronounce&content=聽發音` }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "從字庫刪除", "data": `wid=${wid}&type=delete_from_my_collection&content=從字庫刪除` } },
          { "type": "separator" },
          { "type": "button", "action": { "type": "postback", "label": "查看字庫", "data": `wid=&type=check_my_collection&content=查看字庫` } }
        ] }
      } }]);
    });
  });
}

function playPronounce(event, wid) {
  let w = words.find(x => x.id == wid);
  getAudioDurationInSeconds(`https://words7000.unlink.men/audio/${w.id}.m4a`).then((duration) => {
    client.replyMessage(event.replyToken, { "type": "audio", "originalContentUrl": `https://words7000.unlink.men/audio/${w.id}.m4a`, "duration": duration * 1000 });
  });
}

async function addToUserCollection(event, wid) {
  const userId = event.source.userId;
  const word = words.find(x => x.id == wid);
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['words']; // 抓取名為 words 的分頁
    const rows = await sheet.getRows();
    
    // 檢查是否已存過
    const isExist = rows.find(r => r.get('userId') === userId && r.get('wordId') === wid);
    if (isExist) return client.replyMessage(event.replyToken, { type: "text", text: "此單字已在您的雲端字庫中！" });

    // 檢查上限 (例如 100 字)
    const userWordsCount = rows.filter(r => r.get('userId') === userId).length;
    if (userWordsCount >= 100) return client.replyMessage(event.replyToken, { type: "text", text: "雲端字庫已達上限 (100字)" });

    // 寫入試算表
    await sheet.addRow({ 
      userId: userId, 
      wordId: wid, 
      word: word.word, 
      translate: word.translate 
    });
    return client.replyMessage(event.replyToken, { type: "text", text: "已成功加入雲端字庫！" });
  } catch (err) { console.error('Add Word Error:', err); }
}

async function createUserCollection(event) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['words'];
    const rows = await sheet.getRows();
    const userWords = rows.filter(r => r.get('userId') === userId);

    if (userWords.length === 0) return client.replyMessage(event.replyToken, { type: "text", text: "您的雲端字庫是空的，快去挑戰吧！" });

    let bubble_content = [];
    let box_content = [];
    
    for (let i = 0; i < userWords.length; i++) {
      box_content.push({ "type": "box", "layout": "horizontal", "contents": [
        { "type": "text", "wrap": true, "flex": 5, "text": `${userWords[i].get('word')}\n${userWords[i].get('translate')}` },
        { "type": "button", "flex": 2, "action": { "type": "postback", "label": "查看", "data": `wid=${userWords[i].get('wordId')}&type=check_word&content=查看` }, "style": "secondary" }
      ]});
      
      if ((i + 1) < userWords.length && (i + 1) % 6 != 0) box_content.push({ "type": "separator" });
      
      if ((i + 1) % 6 == 0 || (i + 1) == userWords.length) {
        bubble_content.push({ "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": box_content } });
        box_content = [];
      }
    }
    return client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "我的雲端字庫", "contents": { "type": "carousel", "contents": bubble_content } }]);
  } catch (err) { console.error('List Word Error:', err); }
}

async function deleteFromMyCollection(event, wid) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['words'];
    const rows = await sheet.getRows();
    const targetRow = rows.find(r => r.get('userId') === userId && r.get('wordId') === wid);

    if (targetRow) {
      await targetRow.delete(); 
      return client.replyMessage(event.replyToken, { type: "text", text: "已從雲端字庫刪除！" });
    }
  } catch (err) { console.error('Delete Word Error:', err); }
}

function createPointMessage(user_json) {
  let point = user_json.point;
  let wrong_answer = user_json.wrong_answer || 0;
  let score = point - wrong_answer;
  let gold_stars = score >= 2500 ? 5 : score >= 1000 ? 4 : score >= 500 ? 3 : score >= 100 ? 2 : 1;
  let stars = [];
  for (let i = 0; i < 5; i++) stars.push({ "type": "icon", "size": "sm", "url": `https://scdn.line-apps.com/n/channel_devcenter/img/fx/review_${i < gold_stars ? "gold" : "gray"}_star_28.png` });

  return { "type": "flex", "altText": "你的分數", "contents": { "type": "bubble",
    "header": { "type": "box", "layout": "vertical", "contents": [{ "type": "image", "url": "https://cdn2.ettoday.net/images/5588/5588832.jpg", "size": "full", "aspectRatio": "2:1", "aspectMode": "cover" }], "paddingAll": "0px" },
    "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [
      { "type": "text", "text": `你目前的得分為：${point}分` },
      { "type": "text", "text": `答錯次數：${wrong_answer}次\n\n` },
      { "type": "box", "layout": "baseline", "margin": "md", "contents": stars },
      { "type": "button", "action": { "type": "postback", "label": "繼續測驗", "data": `type=more_test&content=繼續測驗` }, "style": "primary" }
    ] }
  } };
}

function handleUrlParams(data) {
  const params = new URLSearchParams(data);
  return { wid: params.get('wid'), type: params.get('type'), question_type: params.get('question_type'), content: params.get('content') };
}

function getObjectItemIndex(object, id) {
  return object.findIndex(x => x.id == id);
}

function removeByIndex(array, index) {
  let newArray = [...array];
  newArray.splice(index, 1);
  return newArray;
}

/*==================================
 START APP
====================================*/
const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`listening on ${port} - Cloud Sheet Mode Active`); });