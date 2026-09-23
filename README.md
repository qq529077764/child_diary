# 童心日记

面向 5-9 岁儿童的原生微信小程序 MVP。孩子点击开始后持续讲述，系统实时转写、抽取事实并显示动态引导问题；结束后使用事实约束生成日记，并支持语音纠正。

## 核心链路

开始说 → 腾讯语音转文字 → 千问实时事实与追问 → 我说完啦 → 事实审计与成文 → 语音修改 → 本地保存

## 项目结构

- `wechat-miniapp/`：原生微信小程序源码
- `server.js`：腾讯 ASR 与通义千问接口服务
- `mvp-product-spec.md`：当前 MVP 产品与开发说明书
- `.env.example`：后端配置模板

仓库已移除旧网页版原型、未引用图片、演示事实规则和未启用的模型兼容层，只保留当前小程序实际使用的链路。

## 后端启动

1. 将 `.env.example` 复制为 `.env`。
2. 填写腾讯云语音识别和通义千问配置。
3. 启动服务：

```bash
node server.js
```

4. 检查服务：

```text
http://127.0.0.1:5178/health
```

## 小程序运行

1. 将 `wechat-miniapp/utils/config.js` 中的地址改为电脑当前局域网 IP。
2. 使用微信开发者工具导入 `wechat-miniapp/`。
3. 开发测试阶段关闭合法域名校验。
4. 手机与电脑连接同一个 Wi-Fi 后生成预览码测试。

当前测试 AppID 已写入 `project.config.json`。正式发布前必须改用 HTTPS 服务，并在小程序后台配置合法域名。

## 配置项

```text
PORT
TENCENT_SECRET_ID
TENCENT_SECRET_KEY
TENCENT_APP_ID
TENCENT_REGION
TENCENT_ASR_ENGINE_MODEL_TYPE
QWEN_API_KEY
QWEN_MODEL
QWEN_BASE_URL
```

真实 `.env`、微信开发工具私有配置、测试二维码和压缩包均被 Git 忽略。

## 当前边界

- 日记只保存最近一篇到小程序本地存储。
- TTS、登录、云同步和正式内容安全尚未接入。
- 当前后端用于开发测试，未配置生产 HTTPS 部署。

完整产品逻辑和验收标准见 [mvp-product-spec.md](./mvp-product-spec.md)。

