# 券库 · NAS 更新版本详细步骤

> 适用：群晖 Synology（Container Manager）/ 威联通 QNAP（Container Station）
> 目标：把 NAS 上的券库升级到最新版（当前 **v3.35**），或首次部署。
> **核心红线：别弄丢 `data/`**（你的券和截图都在里面）。

---

## 一、先确认你是"首次部署"还是"升级"

- **首次部署**：NAS 上还没有 coupon-stock 容器 → 直接走 **第二节**。
- **升级**：NAS 上已有旧版容器，且里面已经录了券 → 走 **第三节**（带数据备份）。

---

## 二、首次部署（NAS 上还没有券库）

### 1) 准备项目文件
电脑浏览器下载最新源码压缩包（已包含 v3.35）：
```
https://github.com/bin336/coupon-stock/archive/refs/heads/main.zip
```
解压得到 `coupon-stock` 文件夹，整个上传到 NAS 的一个共享文件夹：
- 群晖：`docker/coupon-stock`
- 威联通：`Container/container-station-data/coupon-stock`

> 传完 NAS 上应能看到：`docker-compose.yml`、`Dockerfile`、`server/`、`public/` 等。

### 2) 改两处安全默认值（必做）
打开 `coupon-stock/docker-compose.yml`，把这两行换成你自己的：
```yaml
      - ADMIN_PASS=admin123            # ← 改成你的强密码
      - JWT_SECRET=change-me-...       # ← 改成一段乱码长字符串
```

### 3) 安装容器套件
- 群晖：**套件中心** → 搜 `Container Manager` → 安装
- 威联通：**App Center** → 搜 `Container Station` → 安装

### 4) 用 docker-compose 一键建容器
- **群晖 Container Manager**：项目（Project）→ 创建 → 来源选"现有 docker-compose.yml" → 浏览到 `docker/coupon-stock` → 构建。首次联网拉 Node 镜像 + 装依赖约 2~5 分钟，状态变"运行中"即成功。
- **威联通 Container Station**：创建（Create）→ docker-compose → 把 `docker-compose.yml` 内容粘贴进去（或上传该文件）→ 创建。等镜像构建完，容器显示"运行中"。

### 5) 打开使用
1. 查 NAS 的**内网 IP**（群晖：控制面板→网络；威联通：MyNAS 页面），比如 `192.168.1.50`。
2. 电脑/手机连**同一个家里 WiFi**，浏览器打开：
   ```
   http://192.168.1.50:3000
   ```
3. 默认管理员：`admin` / **你刚设的 ADMIN_PASS**。
4. **首次登录请立即改密码**（右上角头像 → 用户管理 → 重置密码）。

> 内网能打开 = 部署成功。外网访问见另一份《NAS上公网步骤.md》。

---

## 三、升级（NAS 上已有旧版，且里面有券）— 重点防丢数据

> 流程：**停容器 + 备份 data → 换上新代码 → 恢复 data + 重建**。照做不会丢数据。

### 第 1 步：停容器 + 备份数据（SSH）
连上 NAS 的 SSH，进项目文件夹（路径以你实际为准）：
- 威联通常见：`/share/CACHEDEV1_DATA/docker/coupon-stock`
- 群晖常见：`/volume1/docker/coupon-stock`

```bash
cd /share/CACHEDEV1_DATA/docker/coupon-stock   # ← 换成你实际路径
docker compose down
cd /share/CACHEDEV1_DATA/docker
cp -r coupon-stock/data coupon-stock-data-backup
```
> `data` 已备份到 `coupon-stock-data-backup`，下面放心换代码。

### 第 2 步：换上新代码
**方式一（推荐，需 NAS 能联网 + 装了 git）：**
```bash
cd /share/CACHEDEV1_DATA/docker/coupon-stock
git pull
```
**方式二（用 zip）：** 电脑下载 `https://github.com/bin336/coupon-stock/archive/refs/heads/main.zip`，传到 NAS 的 `docker` 文件夹解压 → 生成新的 `coupon-stock`。新版 zip 里**不含 `data/`**，不会动你的数据；加上第 1 步已备份，双保险。

### 第 3 步：恢复数据 + 重建
```bash
cd /share/CACHEDEV1_DATA/docker
cp -r coupon-stock-data-backup coupon-stock/data   # 恢复数据
cd coupon-stock && docker compose up -d --build     # 重建
```
> 因为 Node 镜像第一次已拉到本地，这次 `build` 约 30 秒，不用再下 222MB。看到容器状态 `Up` 即成功，浏览器刷新 `http://NAS的IP:3000` 就能用上新功能。

### 常见坑
| 现象 | 处理 |
|------|------|
| 担心数据丢了 | 第 1 步的 `cp -r .../data ...-backup` 就是保险；万一误删，把备份 `cp` 回去再重启容器即可 |
| build 又去下 222MB | 本地 Node 镜像被清了（如重装过容器套件）。重新按首次部署拉一次镜像即可 |
| 不想删整个文件夹 | 也可以直接把新 zip **解压覆盖**到原文件夹（File Station 选"合并/覆盖"），效果一样，但务必确认 `data/` 没被碰 |

---

## 四、验证更新成功

- 打开 `http://NAS内网IP:3000` → 右上角头像 → **版本更新记录**，确认已到 v3.35。
- 确认券和截图都在（数据没丢）。
- v3.35 新功能可核对：大图视图的「分享」按钮、普通用户「设置 → 个人资料」仅改自己资料等。

---

## 五、安全提醒（上线前必做）

1. `docker-compose.yml` 里改掉 `ADMIN_PASS` 和 `JWT_SECRET` 默认值，别用出厂的。
2. 首次登录立即改管理员密码。

---

> 记住一句话：**更新动代码，不动 `data/`；动之前先备份。**
