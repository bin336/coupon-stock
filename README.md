# 券库 · 优惠券库存管理

> 囤优惠券卖券的库存管理软件。手机浏览器直接打开，多人协作，快速入库、秒搜「未售·未过期」，
> 二维码截图存档，24 小时常驻运行（Docker）。OCR 自动识别 / 闲鱼自动发货为后续增强阶段。

---

## 一、功能概览（第一阶段 MVP）

| 功能 | 说明 |
|------|------|
| 多人手机端 | 内置账号登录，谁登录谁录入，自动带出「所有人」且可改 |
| 快速入库 | 上传二维码截图 + 填商家/金额/券号/张数/过期/成本，所有人自动填充 |
| 秒搜未售未过期 | 列表默认只看「未售 · 未过期」，支持关键词搜商家/券号/所有人 |
| 标记售出 / 编辑 / 删除 | 一张券一键标记售出，可取消；支持编辑与删除 |
| 过期预警 | 已过期未售的券在统计与列表中标红，方便清理 |
| 数据看板 | 顶部统计：在库数量、面值、成本、潜在利润、已过期未售 |
| 用户管理 | 管理员可新增/删除成员、重置密码 |
| 数据持久化 | SQLite 单文件 + 截图目录，备份只需复制整个 `data/` 文件夹 |
| OCR 自动识别 | 上传截图自动识别**金额/券号/张数/过期时间**并预填表单；每个被自动填的字段带「OCR」标记并提示「请核对」，附「识别原文」便于照着改；识别不准可随手改，识别失败自动退回手动填写 |

---

## 二、在 NAS / 电脑上部署（Docker，推荐）

### 1. 前置条件
- 已安装 **Docker** 与 **Docker Compose**。
  - 群晖（Synology）：在「套件中心」安装 **Container Manager**（旧版叫 Docker）。
  - 威联通（QNAP）：安装 **Container Station**。
  - 普通电脑：安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。

### 2. 准备文件
把整个 `coupon-stock` 目录上传/复制到 NAS 的共享文件夹（如 `docker/coupon-stock/`）。

### 3. 修改配置（重要）
编辑 `docker-compose.yml` 或新建 `.env`，**务必改掉默认的账号和密钥**：

```yaml
environment:
  - ADMIN_USER=你的管理员账号
  - ADMIN_PASS=一个强密码
  - JWT_SECRET=一段足够长的随机字符串（可用命令生成：openssl rand -hex 32）
```

### 4. 启动
在 `coupon-stock` 目录下执行：

```bash
docker compose up -d --build
```

首次启动会自动创建数据库并初始化管理员账号。

### 5. 访问
浏览器（手机/电脑）打开 `http://<NAS内网IP>:3000`。
- 想外网访问：在路由器做端口映射，或配合 NAS 的反向代理 + HTTPS（建议加证书，账号密码才安全）。
- 手机可「添加到主屏幕」，像 APP 一样使用。

### 6. 日常运维
```bash
docker compose ps            # 查看运行状态
docker compose logs -f       # 看日志
docker compose restart       # 重启
docker compose down          # 停止（数据不会丢，在 ./data 里）
```
`restart: unless-stopped` 已配置，NAS 重启 / 断电恢复后会自动拉起。

### 关于 OCR 识别
- OCR 用 [tesseract.js](https://github.com/naptha/tesseract.js)（纯 JS/WASM，无需在系统装 Tesseract），识别中文 + 英文数字。
- **首次使用 OCR 时需要联网**：会自动下载中文词库（约 40MB）到 `data/tessdata/`，之后缓存复用、离线也能识别。
- 词库下载/识别失败时**不会阻塞录入**，会自动退回手动填写——你照样能入库。
- 识别结果只是「预填建议」，入库前请逐项核对；不准的地方直接改即可，所有字段都可编辑。

---

## 三、数据备份（极简）

所有数据都在 `coupon-stock/data/` 目录（数据库 `coupon.db` + 截图 `uploads/`）。
**备份 = 复制这个文件夹**；恢复 = 停容器后覆盖回原处再启动。

```bash
# 备份示例（在宿主机执行）
tar czf coupon-backup-$(date +%F).tar.gz data/
```

---

## 四、本地开发 / 调试（不用 Docker）

```bash
npm install
cp .env.example .env      # 按需修改
npm start                 # 默认 http://localhost:3000
```

---

## 五、目录结构

```
coupon-stock/
├── docker-compose.yml     # 部署配置（改账号/密钥在这里）
├── Dockerfile
├── .env.example
├── server/
│   ├── index.js          # 服务入口
│   ├── db.js             # SQLite 建表 + 管理员初始化
│   ├── middleware/auth.js # JWT 鉴权
│   └── routes/
│       ├── auth.js       # 登录 / 用户管理
│       └── coupons.js    # 优惠券 CRUD / 上传 / 统计
├── public/               # 前端（纯静态，无构建步骤，方便手改）
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   └── manifest.json
└── data/                 # 运行时生成：coupon.db + uploads/（已挂载为卷）
```

---

## 六、后续规划（待你确认优先级）

1. **OCR 自动识别**：上传截图自动提取金额/券号/张数/过期时间，录入再快一步。
2. **闲鱼自动发货**：售出后自动推送券号/截图给买家（需对接闲鱼开放接口或 RPA）。
3. **售出记录与利润报表**：按商家/时间段统计已售、利润、周转率。
4. **批量入库 / 导入**：Excel 批量导入，适合一次到货很多券。
5. **操作日志**：谁在什么时候录入/售出/删除，便于对账。

> 这是一个会持续迭代的软件。有任何想调整的地方，告诉我即可逐步优化。
