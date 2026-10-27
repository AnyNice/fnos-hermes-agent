# ---------------------------------------------------------------------------
# sudoers 授权：应用用户免密 cp/chown/psql（auto-update 覆盖/权限修复/版本同步必需）
#
# 背景：monitor 以应用用户（${TRIM_USERNAME}）运行，需要
#   sudo -n cp/chown   覆盖应用文件、修复属主
#   sudo -u postgres psql -d appcenter *   同步应用中心版本
# 未配置时 auto-update 覆盖后应用中心版本不刷新（显示旧版本）。
#
# 本函数幂等、set -e 安全（失败不炸安装），三条写入路径：
#   1. 当前为 root（UID=0）          → 直接写 /etc/sudoers.d/hermes-appcenter
#   2. 有可用的免密 sudo             → 经 sudo 代写
#   3. 都没有（CLI 安装等降级场景）   → 暂存到 ${TRIM_PKGVAR}/sudoers-pending/
#                                       并打出一行 root 修复命令，不静默吞错
#
# 测试钩子（env 覆盖，默认值即线上行为）：
#   SUDOERS_FILE         目标 sudoers 文件（默认 /etc/sudoers.d/hermes-appcenter）
#   SUDOERS_PENDING_DIR  降级暂存目录（默认 ${TRIM_PKGVAR}/sudoers-pending）
#   SUDOERS_GRANT_UID    当前 UID（默认 $(id -u)；测试用）
# ---------------------------------------------------------------------------

install_sudoers_grant() {
    _sg_user="${TRIM_USERNAME:-hermes-agent}"
    _sg_file="${SUDOERS_FILE:-/etc/sudoers.d/hermes-appcenter}"
    _sg_pending="${SUDOERS_PENDING_DIR:-${TRIM_PKGVAR}/sudoers-pending}"
    _sg_uid="${SUDOERS_GRANT_UID:-$(id -u)}"
    _sg_rule="${_sg_user} ALL=(root) NOPASSWD: /bin/cp, /usr/bin/cp, /bin/chown, /usr/bin/chown, /usr/bin/sudo -u postgres /usr/bin/psql -d appcenter *"

    _sg_complete() {
        # 完整 = 文件存在 + 含 chown 规则 + 授权对象是当前应用用户
        [ -f "${_sg_file}" ] && grep -q 'chown' "${_sg_file}" 2>/dev/null && grep -q "^${_sg_user} " "${_sg_file}" 2>/dev/null
    }
    if _sg_complete; then
        log_msg "sudoers 已存在且完整，跳过"
        return 0
    fi

    log_msg ">>> 写入 sudoers 授权（${_sg_file}）..."
    _sg_tmp="${TRIM_PKGVAR}/hermes-appcenter-sudoers.tmp"
    printf '%s\n' "${_sg_rule}" > "${_sg_tmp}"
    chmod 440 "${_sg_tmp}" 2>/dev/null || true

    _sg_written=0
    if [ "${_sg_uid}" = "0" ]; then
        # 路径 1：root 直写
        if cp "${_sg_tmp}" "${_sg_file}" 2>>"${TRIM_PKGVAR}/info.log"; then
            chmod 440 "${_sg_file}" 2>/dev/null || true
            _sg_written=1
        fi
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        # 路径 2：已有免密 sudo → 代写（参数为固定路径，无注入面）
        if sudo -n sh -c "cp '${_sg_tmp}' '${_sg_file}' && chmod 440 '${_sg_file}'" 2>>"${TRIM_PKGVAR}/info.log"; then
            _sg_written=1
        fi
    fi

    rm -f "${_sg_tmp}" 2>/dev/null || true

    if [ "${_sg_written}" = "1" ]; then
        log_msg "sudoers 写入成功"
        return 0
    fi

    # 路径 3：非 root 且无可用 sudo（CLI 安装常见）→ 暂存 + 明确修复指引
    log_msg "sudoers 写入失败（当前用户无 root 权限）"
    mkdir -p "${_sg_pending}" 2>/dev/null || true
    if printf '%s\n' "${_sg_rule}" > "${_sg_pending}/hermes-appcenter" 2>/dev/null; then
        chmod 644 "${_sg_pending}/hermes-appcenter" 2>/dev/null || true
        log_msg "已暂存：${_sg_pending}/hermes-appcenter"
        log_msg "root 修复命令：visudo -c -f ${_sg_pending}/hermes-appcenter && install -m 440 ${_sg_pending}/hermes-appcenter /etc/sudoers.d/hermes-appcenter"
    else
        log_msg "sudoers 暂存失败（${_sg_pending} 不可写），需手动创建 /etc/sudoers.d/hermes-appcenter，内容：${_sg_rule}"
    fi
    # 不报错退出：安装主体已完成，缺 sudoers 仅影响 auto-update 版本同步
    return 0
}
