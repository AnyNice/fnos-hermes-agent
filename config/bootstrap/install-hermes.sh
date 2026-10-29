#!/bin/bash
# Shared dependency-install receipt. The new source stamp is not proof that the
# persistent venv was synced successfully by a previous installation.
hermes_source_id() {
    (cd "${HERMES_SRC}" && sha256sum pyproject.toml uv.lock install-stamp.json) | sha256sum | cut -d ' ' -f 1
}

hermes_dependencies_current() {
    [ -f "${VAR_DIR}/hermes-install.id" ] &&
        [ "$(cat "${VAR_DIR}/hermes-install.id")" = "$(hermes_source_id)" ]
}

# ---------------------------------------------------------------------------
# 方案 2：CPython 3.14 供给链（零新增进程/零在线下载优先）
#
#   1. venv 已是 CPython 3.14            → 无需任何动作（幂等）
#   2. FPK 内置 standalone 预置包        → 解压到 ${DATA_DIR}/python-3.14-<arch>
#      （persistent data 下，升级 FPK 不丢；uv venv 直接指向该解释器，
#       全程不下载 CPython —— 这是国内安装慢的头号杀手）
#   3. 预置缺失/损坏                     → uv managed 安装（国内 GitHub 代理镜像
#      优先，直连兜底）
#
# 预置包来源：astral-sh/python-build-standalone cpython-3.14（install_only，
# 与 `uv python install 3.14` 下载的官方同源资产；打包方在 scripts/package-fpk.py
# 校验阶段确认 config/bootstrap/python/cpython-3.14-<arch>.tar.gz 结构完好）。
# ---------------------------------------------------------------------------
hermes_arch() {
    case "$(uname -m)" in
        x86_64)      echo "x86_64" ;;
        aarch64|arm64) echo "aarch64" ;;
        *)           echo "$(uname -m)" ;;
    esac
}

hermes_cpython_ok() {
    # venv 解释器已是 CPython 3.14 才返回 0（版本门控：官方 48 核心依赖要求 >=3.14）
    [ -d "${VENV_DIR}/bin" ] &&
        "${VENV_DIR}/bin/python3" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)' 2>/dev/null
}

# 创建/重建 venv，保证解释器 = CPython 3.14。成功返回 0。
ensure_hermes_venv() {
    local ARCH PY_HOME BUNDLED_PY
    ARCH="$(hermes_arch)"
    PY_HOME="${DATA_DIR}/python-3.14-${ARCH}"
    BUNDLED_PY="${APP_DIR}/config/bootstrap/python/cpython-3.14-${ARCH}.tar.gz"

    # ① 预置 standalone：解压到 persistent data，直接作为 venv 解释器
    if [ -f "${BUNDLED_PY}" ]; then
        if [ ! -x "${PY_HOME}/bin/python3.14" ]; then
            log_msg ">>> 解压内置 CPython 3.14 (${ARCH}) → ${PY_HOME} ..."
            local TMP_UNPACK="${DATA_DIR}/.py-unpack.$$"
            rm -rf "${TMP_UNPACK}" && mkdir -p "${TMP_UNPACK}"
            # install_only 包顶层为 python/；解包失败（损坏/截断）则落在线兜底
            if ! tar xzf "${BUNDLED_PY}" -C "${TMP_UNPACK}" 2>>"${LOG_FILE}" || \
               [ ! -x "${TMP_UNPACK}/python/bin/python3.14" ]; then
                log_msg "WARNING: 内置 CPython 包解压失败，回退 uv 在线安装"
                rm -rf "${TMP_UNPACK}"
            else
                rm -rf "${PY_HOME}" 2>/dev/null || true
                mv "${TMP_UNPACK}/python" "${PY_HOME}"
                rm -rf "${TMP_UNPACK}"
            fi
        else
            log_msg "内置 CPython 3.14 已就位: ${PY_HOME}"
        fi
        if [ -x "${PY_HOME}/bin/python3.14" ]; then
            "${UV}" venv --python "${PY_HOME}/bin/python3.14" "${VENV_DIR}" 2>>"${LOG_FILE}"
            if hermes_cpython_ok; then
                log_msg "venv created from bundled CPython 3.14 (zero download)"
                return 0
            fi
            log_msg "WARNING: 内置 CPython 建 venv 失败，回退 uv 在线安装"
        fi
    fi

    # ② uv managed：国内 GitHub 代理优先（pbs 资产走 ghproxy），直连兜底
    local PGB_MIRROR="https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/download"
    log_msg ">>> 正在安装 CPython 3.14 (uv python install, 镜像优先) ..."
    if ! "${UV}" python install 3.14 --mirror "${PGB_MIRROR}" 2>>"${LOG_FILE}"; then
        log_msg "WARNING: 镜像源安装 CPython 失败，尝试 GitHub 直连 ..."
        if ! "${UV}" python install 3.14 2>>"${LOG_FILE}"; then
            log_msg "ERROR: CPython 3.14 安装失败（内置/镜像/直连均不可用）"
            return 1
        fi
    fi
    "${UV}" venv --python 3.14 "${VENV_DIR}" 2>>"${LOG_FILE}"
    hermes_cpython_ok || {
        log_msg "ERROR: venv 解释器不是 CPython 3.14"
        return 1
    }
    log_msg "venv created (python 3.14, uv managed)"
    return 0
}

# ---------------------------------------------------------------------------
# 方案 1：依赖安装，国内源优先（清华 → 阿里云 → pypi.org 兜底）
# 官方源排在最后：国内 NAS 首连 pypi.org 常卡死/龟速，超时后才回退，
# 这是全新安装/跨核心版本升级安装慢的主因。
# ---------------------------------------------------------------------------
install_hermes_from_source() {
    if [ ! -f "${HERMES_SRC}/pyproject.toml" ]; then
        log_msg "ERROR: bundled hermes-src is missing; rebuild the FPK with the pinned source"
        return 1
    fi

    # 方案 0（0.22.5+ 必需）：走随包 uv.lock 的锁化安装。
    # 官方 0.22.5 起 pillow==13.0.0（安全通告驱动）与 browser-harness==0.1.13
    # 自身的 pillow==12.3.0 硬冲突；bare `uv pip install` 解析直接失败。
    # 冲突通过 [tool.uv] overrides 记录在 uv.lock 里，只有锁化安装
    # （uv sync --frozen）能带着 override 通过。旧核心（无此冲突）走下面兜底。
    if [ -f "${HERMES_SRC}/uv.lock" ]; then
        local index
        for index in \
            https://pypi.tuna.tsinghua.edu.cn/simple \
            https://mirrors.aliyun.com/pypi/simple/ \
            https://pypi.org/simple
        do
            log_msg "Syncing bundled Hermes [all,voice] from lock (index: ${index}) ..."
            if UV_INDEX_URL="${index}" VIRTUAL_ENV="${VENV_DIR}" \
                    "$UV" sync --active --frozen \
                    --project "${HERMES_SRC}" \
                    --extra all --extra voice >>"${LOG_FILE}" 2>&1; then
                if timeout 30 "${HERMES}" --version >>"${LOG_FILE}" 2>&1; then
                    mkdir -p "${VAR_DIR}"
                    hermes_source_id > "${VAR_DIR}/hermes-install.id"
                    log_msg "Hermes [all,voice] synced OK from lock (index: ${index})"
                    return 0
                fi
            fi
            log_msg "Lock sync failed on ${index}, trying next"
        done
    fi

    # 方案 1（兜底）：依赖安装，国内源优先（清华 → 阿里云 → pypi.org 兜底）
    local index
    for index in \
        https://pypi.tuna.tsinghua.edu.cn/simple \
        https://mirrors.aliyun.com/pypi/simple/ \
        https://pypi.org/simple
    do
        log_msg "Installing bundled Hermes [all,voice] from ${index} ..."
        if UV_INDEX_URL="${index}" "$UV" pip install --python "${VENV_DIR}/bin/python3" \
                -e "${HERMES_SRC}[all,voice]" >>"${LOG_FILE}" 2>&1; then
            if timeout 30 "${HERMES}" --version >>"${LOG_FILE}" 2>&1; then
                mkdir -p "${VAR_DIR}"
                hermes_source_id > "${VAR_DIR}/hermes-install.id"
                log_msg "Hermes [all,voice] installed OK (index: ${index})"
                return 0
            fi
        fi
        log_msg "Index ${index} failed, trying next"
    done
    return 1
}
