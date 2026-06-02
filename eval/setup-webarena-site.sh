#!/usr/bin/env bash
# 一键起一个 WebArena docker 站点。幂等:可反复跑(已下/已 load/已起会跳过)。
# 用法: eval/setup-webarena-site.sh [site]   (site 默认 shopping_admin)
#
# 已测试: shopping_admin。其它站点走相同的 下载→load→run 流程,但 magento 以外的
# 站点(reddit/gitlab)的 base_url/外部URL 配置各异 —— 见官方 README:
#   https://github.com/web-arena-x/webarena/blob/main/environment_docker/README.md
#
# 注意(Apple Silicon / arm64):WebArena 镜像是 amd64,php-fpm 在 qemu 用户态模拟下
# 会 SIGSEGV。必须在 Docker Desktop 开启 "Use Rosetta for x86/amd64 emulation" 并重启。
# 本脚本会检测并提示。
set -euo pipefail

SITE="${1:-shopping_admin}"
MIRROR="http://metis.lti.cs.cmu.edu/webarena-images"
IMG_DIR="${WEBARENA_IMG_DIR:-$HOME/webarena-images}"

# site -> "tar文件 端口 类型"   (类型 magento 的会自动配 base_url)
case "$SITE" in
  shopping_admin) TAR="shopping_admin_final_0719.tar"; PORT=7780; KIND=magento; PATHSUFFIX="/admin" ;;
  shopping)       TAR="shopping_final_0712.tar";       PORT=7770; KIND=magento; PATHSUFFIX="" ;;
  reddit)         TAR="postmill-populated-exposed-withimg.tar"; PORT=9999; KIND=other; PATHSUFFIX="" ;;
  gitlab)         TAR="gitlab-populated-final-port8023.tar";    PORT=8023; KIND=other; PATHSUFFIX="" ;;
  *) echo "未知 site: $SITE(支持 shopping_admin / shopping / reddit / gitlab)" >&2; exit 1 ;;
esac
IMAGE="${TAR%.tar}"

echo "==> 站点 $SITE  (镜像 $IMAGE, 端口 $PORT, 类型 $KIND)"

# --- 0. 前置检查 ---
command -v docker >/dev/null || { echo "✗ 需要 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker 守护进程未运行(打开 Docker Desktop)" >&2; exit 1; }

# Apple Silicon + magento: 检查 Rosetta(否则 php-fpm 会崩)
if [ "$(uname -m)" = "arm64" ] && [ "$KIND" = "magento" ]; then
  SETTINGS="$HOME/Library/Group Containers/group.com.docker/settings-store.json"
  if [ -f "$SETTINGS" ] && grep -q '"UseVirtualizationFrameworkRosetta": *true' "$SETTINGS"; then
    echo "    ✓ Rosetta 已开启"
  else
    echo "    ⚠ 检测到 arm64 但 Docker Desktop 未开 Rosetta。" >&2
    echo "      magento 的 php-fpm 在 qemu 下会 SIGSEGV(502)。请到" >&2
    echo "      Docker Desktop → Settings → General → 勾选 \"Use Rosetta for x86/amd64 emulation\" → Restart," >&2
    echo "      然后重跑本脚本。(会顺带重启你其它容器。)" >&2
    read -r -p "      已开启并想继续?[y/N] " ans
    [ "$ans" = "y" ] || exit 1
  fi
fi

# --- 1. 下载镜像 tar(断点续传) ---
mkdir -p "$IMG_DIR"
TARPATH="$IMG_DIR/$TAR"
EXPECTED=$(curl -sIL --max-time 30 "$MIRROR/$TAR" | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r' | tail -1)
CUR=$(stat -f%z "$TARPATH" 2>/dev/null || stat -c%s "$TARPATH" 2>/dev/null || echo 0)
if [ -n "$EXPECTED" ] && [ "$CUR" = "$EXPECTED" ]; then
  echo "==> [1/4] tar 已完整下载 ($CUR bytes),跳过"
else
  echo "==> [1/4] 下载 $TAR (~$(( ${EXPECTED:-0} / 1000000000 ))GB,CMU 服务器可能较慢,支持断点续传)"
  curl -L -C - -o "$TARPATH" "$MIRROR/$TAR"
fi

# --- 2. docker load(已有镜像则跳过) ---
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> [2/4] 镜像 $IMAGE 已存在,跳过 load"
else
  echo "==> [2/4] docker load(几分钟)"
  docker load --input "$TARPATH"
fi

# --- 3. docker run(已有容器则复用/启动) ---
if docker ps -a --format '{{.Names}}' | grep -qx "$SITE"; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$SITE")" = "true" ]; then
    echo "==> [3/4] 容器 $SITE 已在运行"
  else
    echo "==> [3/4] 启动已存在的容器 $SITE"
    docker start "$SITE" >/dev/null
  fi
else
  echo "==> [3/4] docker run $SITE -p $PORT:80"
  docker run --name "$SITE" -p "$PORT:80" -d "$IMAGE" >/dev/null
fi

# --- 4. 配置 ---
if [ "$KIND" = "magento" ]; then
  echo "==> [4/4] 等 magento php-fpm 就绪 + 配 base_url 为 http://localhost:$PORT"
  for i in $(seq 1 48); do
    st=$(docker exec "$SITE" supervisorctl status php-fpm 2>/dev/null | awk '{print $2}')
    [ "$st" = "RUNNING" ] && break
    sleep 10
  done
  docker exec "$SITE" /var/www/magento2/bin/magento setup:store-config:set --base-url="http://localhost:$PORT" >/dev/null 2>&1 || true
  docker exec "$SITE" mysql -u magentouser -pMyPassword magentodb \
    -e "UPDATE core_config_data SET value='http://localhost:$PORT/' WHERE path IN ('web/secure/base_url','web/unsecure/base_url');" >/dev/null 2>&1 || true
  docker exec "$SITE" /var/www/magento2/bin/magento cache:flush >/dev/null 2>&1 || true
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 40 "http://localhost:$PORT$PATHSUFFIX" || echo 000)
  echo "    访问: http://localhost:$PORT$PATHSUFFIX  (HTTP $CODE; 200 即就绪,502 再等一会)"
else
  echo "==> [4/4] $SITE 非 magento,post-start 配置见官方 README(reddit/gitlab 各异)"
  echo "    端口已映射: http://localhost:$PORT"
fi

echo ""
echo "站点 $SITE 就绪 ✅  下一步见 eval/README.md(配 PIE_EVAL_* 跑任务)"
