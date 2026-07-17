# 券库 · NAS 部署指南（24 小时稳定运行）

本指南帮你把「券库」装到家里的 NAS 上，做到 **7×24 小时开机运行**，手机随时用流量也能查券、卖券。
不需要懂代码，跟着步骤点就行。

---

## 一、先确认你的 NAS 品牌

| 品牌 | 套件名 | 本文对应说法 |
|------|--------|------|
| 群晖 Synology | **Container Manager**（旧版叫 Docker） | "容器套件" |
| 威联通 QNAP | **Container Station** | "容器套件" |

> 不确定就进 NAS 后台的「套件中心 / App Center」搜一下，能装 Container Manager / Container Station 就行。

---

## 二、整体思路（一句话）

> 把 `coupon-stock` 文件夹传到 NAS → 用容器套件按里面的 `docker-compose.yml` 一键建容器 → 浏览器开 `NAS内网IP:3000` 就能用。

数据（券 + 截图）存在 NAS 硬盘上，容器删了重建也不丢。

---

## 三、准备项目文件

1. 在**预览地址**里下载 `coupon-stock-backup.zip`（就是平时更新的那个压缩包）
2. 在电脑上解压，得到 `coupon-stock` 文件夹
3. 把这个文件夹整个上传到 NAS 的一个共享文件夹里，建议放：
   - 群晖：`docker/coupon-stock`
   - 威联通：`Container/container-station-data/coupon-stock`
   （用什么方式传都行：File Station 网页上传、或电脑映射网络驱动器后直接拖进去）

传完以后，NAS 上应该能看到这个结构：
```
coupon-stock/
├── docker-compose.yml   ← 关键，容器套件靠它建服务
├── Dockerfile
├── package.json
├── server/
├── public/
└── …
```

---

## 四、安装容器套件

- 群晖：**套件中心** → 搜 `Container Manager` → 安装
- 威联通：**App Center** → 搜 `Container Station` → 安装

装好后桌面上会出现一个容器图标。

---

## 五、用 docker-compose 一键建容器

### 群晖 Container Manager
1. 打开 **Container Manager**
2. 左侧点 **项目（Project）** → 右上角 **创建**
3. 项目来源选 **"现有 docker-compose.yml"**，路径浏览到 `docker/coupon-stock`
4. 点 **下一步** → **构建**（首次会联网拉 Node 镜像 + 装依赖，约 2~5 分钟，耐心等）
5. 状态变 **"运行中"** 即成功

### 威联通 Container Station
1. 打开 **Container Station**
2. 顶部点 **创建（Create）** → 选 **docker-compose**
3. 把 `coupon-stock` 里的 `docker-compose.yml` 内容粘贴进去（或在上传区选该文件）
4. 点 **创建 / 验证并创建**
5. 等镜像构建完，容器显示 **运行中**

> 卡在"拉镜像/装依赖"很久？多半是 NAS 没联网或网速慢，确认 NAS 能上外网即可，不用其它操作。

---

## 六、打开使用

1. 查出 NAS 的**内网 IP**（群晖：控制面板→网络；威联通：MyNAS 页面），比如 `192.168.1.50`
2. 电脑/手机连**同一个家里的 WiFi**，浏览器打开：
   ```
   http://192.168.1.50:3000
   ```
3. 默认管理员账号：`admin` / `admin123`
4. **首次登录请立即改密码**（右上角你的头像 → 用户管理 → 重置密码，或见下方"安全"一节）

> 内网能打开，说明部署成功。下面教你怎么让手机**不在 WiFi 下**（用流量）也能打开。

---

## 七、手机在外网也能访问（重点）

你卖券要在微信里随时查，靠家里 WiFi 不够。最省事、最安全的方法是装 **Tailscale**（免费、不用做端口映射、全程加密）。

### 步骤
1. NAS 装 Tailscale 套件：
   - 群晖：套件中心搜 `Tailscale` 安装，登录一个 Tailscale 账号（用 Google/微软邮箱注册）
   - 威联通：App Center 搜 `Tailscale` 安装并登录
2. 手机应用商店装 **Tailscale App**，登录**同一个账号**
3. 手机打开 Tailscale（连上后），浏览器访问：
   ```
   http://<NAS的TailscaleIP>:3000
   ```
   Tailscale IP 在 App 里能看到（形如 `100.x.x.x`）
4. 以后手机只要开着 Tailscale，走到哪儿都能开券库，跟你在家一样。

> 为什么推荐 Tailscale 而不是"端口映射+DDNS"？后者要在路由器上操作、把 NAS 暴露到公网，新手容易配错还有安全风险。Tailscale 不用碰路由器，最稳。

---

## 八、把电脑上已有的券搬过来（数据迁移）

如果你电脑上已经录了券，想直接带到 NAS：

1. 电脑上找到 `coupon-stock/data` 文件夹（里面是 `coupon.db` 和 `uploads/`）
2. 把整个 `data` 文件夹**覆盖**到 NAS 的 `docker/coupon-stock/data`
   （用 File Station 或网络驱动器拖过去，提示重复就覆盖）
3. 在容器套件里**重启** coupon-stock 容器即可看到数据

> 全新部署、NAS 上还没有券的话，跳过这步，直接录入就好。

---

## 九、备份（重要）

你的全部家当都在 `data` 文件夹里：
- `data/coupon.db` ：库存数据库
- `data/uploads/` ：所有二维码截图

**备份 = 定期把 `docker/coupon-stock/data` 整个拷一份到别处**（U 盘、电脑、或 NAS 自己的备份套件）。
**恢复 = 把备份的 `data` 覆盖回去 + 重启容器**。

---

## 十、日常更新代码（保数据，重点）

代码会持续迭代。更新时**唯一要守住的红线：别弄丢 `data/`**（你的券和截图都在里面）。
下面这套流程"先备份数据 → 再换代码 → 最后恢复数据"，最稳，照做不会丢数据。

### 第 1 步：停容器 + 备份数据（SSH）
先连上 NAS 的 SSH，进到你的项目文件夹（路径以你实际为准）：
- 威联通常见路径：`/share/CACHEDEV1_DATA/docker/coupon-stock-main`
- 群晖常见路径：`/volume1/docker/coupon-stock`

```bash
cd /share/CACHEDEV1_DATA/docker/coupon-stock-main   # ← 换成你实际路径
docker compose down
cd /share/CACHEDEV1_DATA/docker
cp -r coupon-stock-main/data coupon-stock-data-backup
```

### 第 2 步：换上新代码（File Station）
1. 删除 NAS 上的 `coupon-stock-main` 文件夹（数据已备份，放心删）
2. 电脑浏览器下载最新源码：
   ```
   https://github.com/bin336/coupon-stock/archive/refs/heads/main.zip
   ```
3. 把 zip 传到 NAS 的 `docker` 文件夹，解压 → 生成新的 `coupon-stock-main`
   （新版 zip 里**不含 `data/`**，不会动你的数据；加上第 1 步已备份，双保险）

### 第 3 步：恢复数据 + 重建（SSH）
```bash
cp -r coupon-stock-data-backup coupon-stock-main/data
cd coupon-stock-main && docker compose up -d --build
```

> 因为 Node 镜像你第一次已经 `docker load` 到本地了，**这次 build 约 30 秒**，不用再下 222MB。
> 看到容器状态 `Up` 即成功，浏览器刷新 `http://NAS的IP:3000` 就能用上新功能。

### 常见坑
| 现象 | 处理 |
|------|------|
| 担心数据丢了 | 第 1 步的 `cp -r .../data ...-backup` 就是保险；万一误删，把备份 `cp` 回去再重启容器即可 |
| build 又去下 222MB | 本地 Node 镜像被清了（如重装过 Container Station）。重新按首次部署的"离线镜像"步骤 `docker load` 一次即可 |
| 不想删整个文件夹 | 也可以直接把新 zip **解压覆盖**到原文件夹（File Station 选"合并/覆盖"），效果一样，但务必确认 `data/` 没被碰 |

> 记住一句话：**更新动代码，不动 `data/`；动之前先备份。**

---

## 十一、安全提醒（上线前必做）

在 `docker-compose.yml` 里改掉这两项默认值，别用出厂的：
- `ADMIN_PASS=admin123` → 改成你自己的强密码
- `JWT_SECRET=change-me-...` → 改成一段乱码长字符串（随便敲一串英文数字即可）

改完保存，**重建容器**生效。

---

## 十二、常见问题

| 现象 | 可能原因 / 解决 |
|------|------|
| 构建卡很久 | NAS 在联网拉镜像/装依赖，等几分钟；确认 NAS 能上外网 |
| 打开 IP:3000 连不上 | 确认手机/电脑和 NAS 在**同一 WiFi**；或 Tailscale 是否已连 |
| 券的"已过期"判断不对 | 已通过容器 `TZ=Asia/Shanghai` 固定时区，若仍异常检查 NAS 时间是否准确 |
| OCR 识别点不动 | OCR 首次使用需联网下载语言包，确认 NAS 能上外网 |
| 数据没了 | 检查 `data` 卷是否挂载成功；按第九节从备份恢复 |

---

部署遇到卡点，把 NAS 套件名 + 报错截图发我，我帮你针对性解决。
