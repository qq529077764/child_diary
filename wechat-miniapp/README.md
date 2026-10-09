# 童心日记微信小程序

这是原生微信小程序项目，不使用 H5 或 `web-view`。

## 导入

1. 打开微信开发者工具并选择“导入项目”。
2. 项目目录选择本文件夹 `wechat-miniapp`。
3. 正式 AppID 已配置在 `project.config.json`。
4. 开发测试阶段在“详情 → 本地设置”关闭合法域名校验。
5. 点击编译，在模拟器确认页面后生成真机预览码。

## 后端地址

`utils/config.js` 使用正式 HTTPS 接口：

```js
const API_BASE_URL = "https://childdiary.127space.com";
```

正式测试前需将该域名配置为小程序 `request` 和 `uploadFile` 合法域名。

## 当前交互

- 开始后持续录音，约每 6 秒自动上传一个音频分段。
- 实时字幕固定显示末尾约三行。
- 引导问题会保留并自动滚动到最新一条。
- 家长说话引导、电视台词和与主线无关的串音会在实时抽取和最终成文前进行两次过滤。
- 孩子中途直接继续说，不需要点击问题。
- 点击或说“我说完啦”后生成日记。
- 支持自然重说相关场景，也支持语音替换、删除、补充事实和删除句内多余短语；未涉及内容保持不变。
- 确认后的日记保存到服务器，本地 `diaryHistory` 作为离线副本。
- 旧版本地日记首次登录时自动上传，失败后下次启动重试。
- 日记详情页支持二次确认后删除。

## 接口

- `POST /api/asr`
- `POST /api/analyze`
- `POST /api/finalize`
- `POST /api/revise`
- `POST /api/compose`
- `POST /api/auth/session`
- `POST /api/diaries`
- `GET /api/diaries`
- `GET /api/diaries/:id`
- `DELETE /api/diaries/:id`
- `GET /health`

后端密钥只保存在服务器 `.env`，不得写入小程序源码。

## 正式发布前

- 部署 HTTPS 后端并配置 `request`、`uploadFile` 合法域名。
- 接入正式儿童内容安全策略。
- 根据需要增加登录、云端保存和 TTS。
