# 网关接入指南 · OpenAI 兼容 `/v1`

life-world 自带一个 OpenAI 兼容网关，让只认 `/v1` 的客户端（视觉小说、桌宠、聊天前端）接进来。
**人格、记忆、工具全在 life-world 这边**，客户端只负责显示。

- 端点：`GET /v1/models`、`POST /v1/chat/completions`（stream / 非 stream）、`GET /health`
- 默认地址：`http://127.0.0.1:8100/v1`

---

## 1. 打开网关

看板 → **扩展功能 → 网关 · OpenAI 兼容**：

1. 勾选**启用网关**；
2. **BaseURL** 一行直接填地址和端口——`http://[地址]:[端口]/v1`，两个方框就是「监听地址」和「端口」；
3. **模型**：下拉选「在线 / 本地」，这才是网关实际用的模型（客户端传的模型名只决定语气约定，不影响这里）；
4. **Token**：可空；**监听非回环地址时必须填**，否则网关拒绝启动；
5. **单轮超时**：默认开，120 秒，按请求最长算；
6. 点**保存并重启**。

### 地址怎么选

| 监听地址 | 谁能连 | 说明 |
|---|---|---|
| `127.0.0.1` | 只有本机 | 默认，最安全 |
| `0.0.0.0` | 局域网所有设备 | 手机/平板/另一台电脑要连时用，**必须配 token** |

浏览器里跑的客户端（网页版）属于跨源请求，要在 `life-world.json` 的 `gateway.allowOrigins` 里加上它的来源，否则 403。

---

## 2. 三个模型名

模型名只决定「终端约定」——人格和记忆完全一样：

| 模型名 | 给谁 | 终端约定 |
|---|---|---|
| `life-world` | 通用聊天前端 | 不加任何约定 |
| `life-world-vn` | 视觉小说（AnimaVN） | 每句台词行首写 `<sprite:表情>` |
| `life-world-pet` | 桌宠（dsh-pet-indesktop） | 回复短，一两句 |

---

## 3. AnimaVN 接入

### 3.1 在 AnimaVN 里加一个服务商

| 项 | 填什么 |
|---|---|
| 协议 | OpenAI 兼容 |
| BaseURL | `http://<跑网关那台机器的 IP>:8100/v1`（同机就是 `127.0.0.1`） |
| API Key | 看板里设的 token；没设就留空或随便填 |
| 模型 | `life-world-vn` |

### 3.2 立绘标签必须两边对上

AnimaVN 认的标签是 **`<sprite:表情>`**，例如：

```
<sprite:微笑>「哥哥回来啦～」
```

网关的 `life-world-vn` 提示词已经按这个格式写。AnimaVN 那边的「插件页 → 立绘 → 标签格式」默认也是 `<sprite:{表情}>`，**两边别只改一边**——只改提示词或只改模板，都会切不动。

### 3.3 表情名要能匹配上

1. **卡上的立绘名优先**：`<sprite:开心>` 要能对上这张卡里叫「开心」的差分；
2. 对不上会走后端 bge 模型兜底，挑最接近的一张；
3. 模型没装或出错 → 保持当前立绘，AnimaVN 控制台会标红写原因。

网关提示词里给的是内置的 16 个基础表情：平静 / 微笑 / 开心 / 温柔 / 认真 / 担心 / 难过 / 哭 / 惊讶 / 慌张 / 害羞 / 疑惑 / 生气 / 害怕 / 厌恶 / 忧郁。卡上差分名字不一样时，改 AnimaVN 那边的别名，或让模型自己往近义上挑。

### 3.4 不换脸怎么排查

按顺序看三件事：

1. **格式**——提示词和 AnimaVN 标签模板是不是都是 `<sprite:…>`；
2. **立绘包**——这张卡有没有绑立绘包，没绑就没有图可切；
3. **控制台**——有没有红字「对不上」，有的话是表情名没匹配，不是格式问题。

---

## 4. 桌宠 dsh-pet-indesktop 接入

和 AnimaVN 一样，只是模型名换掉：

| 项 | 填什么 |
|---|---|
| BaseURL | `http://<IP>:8100/v1` |
| API Key | 看板里的 token（没设可空） |
| 模型 | `life-world-pet` |

桌宠档只加一句「回复要短」，不涉及立绘标签。

---

## 5. 其他客户端

任意 OpenAI SDK / 聊天前端：BaseURL 填 `http://<IP>:8100/v1`，模型填 `life-world`，Key 填 token（没设可留空）。

```bash
curl http://127.0.0.1:8100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"model":"life-world","messages":[{"role":"user","content":"在吗"}],"stream":false}'
```

---

## 6. 行为与限制

- **客户端历史全部丢弃**：只认最后一条 `user`，人格和记忆以 life-world 为准；客户端的 system prompt 不生效。
- **单并发**：所有客户端共用一个会话排队跑（本地模型更明显），忙时会等。
- **图片**：`image_url` 的 data URL，png/jpeg/webp/gif，单张 ≤8MB、最多 4 张；模型本身得支持看图。
- **流式**：支持 SSE；要用量就在请求里加 `stream_options.include_usage`。
- **鉴权**：`Authorization: Bearer <token>`；Host 头在回环绑定时会校验（防 DNS rebinding）。

---

## 7. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 未授权 | token 不对或没带 | 看板里核对 token |
| 403 Host 不被接受 | 回环绑定时用非 localhost 的 Host 访问 | 用 `127.0.0.1` / `localhost`，或改绑 `0.0.0.0` |
| 403 Origin 不在允许列表 | 浏览器跨源 | 在 `gateway.allowOrigins` 加来源 |
| 415 Content-Type 必须是 application/json | 客户端没发 JSON 头 | 检查客户端设置 |
| 网关起不来，日志说「没有设 token」 | 监听 `0.0.0.0` 但 token 为空 | 填一个 token 再启动 |
| 回复不像 / 不换立绘 | 模型名填错（用了 `life-world` 而不是 `-vn`） | 换成对应模型名 |
