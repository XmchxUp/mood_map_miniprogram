# Mood Map Local Go Server

本地版后端，用 Go 标准库实现，数据写入本地 JSON 文件。

## 运行

```bash
cd server
go run .
```

默认监听：

```text
http://127.0.0.1:8080
```

数据会保存到：

```text
server/data/moods.json
```

## 小程序开发者工具设置

在微信开发者工具中勾选：

```text
详情 -> 本地设置 -> 不校验合法域名、web-view、TLS 版本以及 HTTPS 证书
```

模拟器访问本机时可以使用默认地址 `http://127.0.0.1:8080`。
真机调试时要把 `utils/api.js` 里的 `LOCAL_API_BASE` 改成电脑局域网 IP，例如：

```js
const LOCAL_API_BASE = 'http://192.168.1.23:8080';
```

## 接口

```text
POST /api/submitMood
POST /api/getHeatmap
POST /api/getNearbyMoods
GET  /api/getStats
```

返回结构保持为小程序原来使用的格式：

```json
{
  "result": {
    "ok": true
  }
}
```
