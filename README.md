# 童心日记

面向 5-9 岁儿童的原生微信小程序 MVP。孩子点击开始后持续讲述，系统实时转写、抽取事实并显示动态引导问题；结束后使用事实约束生成日记，并支持语音纠正。

**当前正式基线：** 微信小程序 `1.0.0`，已于 2026-10-15 通过审核并作为首个上线版本。审核通过的功能代码基线为 `486c389`，后续开发统一以 `main` 为起点。

## 核心链路

开始说 → 腾讯语音转文字 → 实时事实与引导 → 我说完啦 → 最终事实审计 → 低年级日记成文 → 基于事实ID的语音修改 → 服务器保存

## 项目结构

- `wechat-miniapp/`：原生微信小程序源码
- `server.js`：腾讯 ASR 与阿里云百炼文本模型接口服务
- `mvp-product-spec.md`：当前 MVP 产品与开发说明书
- `compliance/童心日记儿童个人信息保护规则.txt`：审核可上传的儿童隐私补充规则
- `regression-cases/`：与生产逻辑隔离的匿名回归案例库
- `.env.example`：后端配置模板

仓库已移除旧网页版原型、未引用图片、演示事实规则和未启用的模型兼容层，只保留当前小程序实际使用的链路。

## 后端启动

1. 将 `.env.example` 复制为 `.env`。
2. 填写腾讯云语音识别和阿里云百炼配置。当前主模型为 Qwen，快速审计模型为 DeepSeek。
3. 启动服务：

```bash
node server.js
```

4. 检查服务：

```text
http://127.0.0.1:5178/health
```

## 小程序运行

1. 生产版使用 `https://childdiary.127space.com`；如需本机调试，临时将 `wechat-miniapp/utils/config.js` 改为电脑当前局域网 IP。
2. 使用微信开发者工具导入 `wechat-miniapp/`。
3. 开发测试阶段关闭合法域名校验。
4. 手机与电脑连接同一个 Wi-Fi 后生成预览码测试。

事实成文、服务端路由与修改事务回归测试：

```bash
node scripts/test-server-logic.js
node scripts/test-fact-pipeline.js
node scripts/test-fact-api.js
node scripts/test-miniapp-revision.js
node scripts/test-privacy-storage.js
```

正式提示词通用性检查：

```bash
node scripts/test-prompt-generality.js
```

生产提示词不得叠加单次测试的人名、地点、活动或原句。测试问题先记录到案例库，确认属于可复现的共性或违反核心事实约束后，再抽象为通用规则。

当前正式 AppID 已写入 `project.config.json`，接口使用 HTTPS 服务；后续每次发布前仍需确认小程序后台的 `request` 和 `uploadFile` 合法域名配置未被改动。

## 1.0.0 发布状态

- 微信审核：已通过。
- Git 主干：`main`，审核版功能代码为 `486c389`。
- 生产 API：`https://childdiary.127space.com`，健康检查正常。
- 小程序端：正式 AppID `wxafcdee5f8f0d4250`，使用正式 HTTPS 接口。
- 隐私保护：已申报麦克风、OpenID 和用户输入文本，并提交儿童个人信息保护补充文档。

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
QWEN_FAST_MODEL
QWEN_ENABLE_THINKING
QWEN_BASE_URL
```

真实 `.env`、微信开发工具私有配置、测试二维码和压缩包均被 Git 忽略。

## 日记存储

- 日记保存在服务器 SQLite 数据库，按微信用户隔离。
- 首次连接服务器或打开麦克风前必须取得监护人同意；服务端也会校验同意记录。
- 支持历史列表、详情查询和单篇永久删除。
- “家长与隐私”位于“我的日记”页底部；如需撤回同意、更正信息或删除全部数据，通过页内邮箱联系管理员处理。
- 本机 `diaryHistory` 作为离线副本，旧版日记在首次登录时自动上传，云端同步失败时下次启动重试。
- 隔离数据库备份默认保留 30 天，不用于日常查询，到期自动清理。

## 服务器部署

- `Dockerfile` 和 `compose.yaml` 运行 Node.js 24 API 容器。
- 容器只绑定 `127.0.0.1:5178`，公网由 Nginx 反向代理。
- 生产域名为 `https://childdiary.127space.com`。
- 数据库持久化到 `./data/child-diary.sqlite`，该目录不进入 Git。
- `scripts/backup-database.js` 使用 SQLite 在线备份 API 生成一致性副本，服务器每日执行并默认保留 30 天。

## 当前边界

- 微信登录需要在服务器 `.env` 配置 AppSecret，不得写入小程序或 Git。
- 当前录音采用约 6.2 秒分段的一句话识别，不是腾讯实时语音流。
- TTS、实时语音流和更完整的儿童内容安全能力列入后续版本，不属于 1.0.0 已上线范围。

完整产品逻辑和验收标准见 [mvp-product-spec.md](./mvp-product-spec.md)。
