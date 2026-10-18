"""Weixin / QQBot onboarding: apply step (write config via Hermes' own writers).

The Node host drives the QR protocol in-process (fetch + node:crypto, mirroring
feishu-onboarding.mjs). Only the final apply is a short-lived Python helper,
identical in shape to feishu-config.py: one JSON object on stdin, one on stdout.

Writes use Hermes' profile-scoped dotenv writer, platform config writer, and the
core's own weixin account store so credentials land exactly where the adapters
expect them (never in the repo, never in the browser).

stdin:  {"platform":"weixin"|"qqbot","profile":"default",
         "credentials":{...}, "options":{"dm_policy":...,"allowed_users":...,
         "group_policy":...,"group_allowed_users":...,"home_channel":...}}
stdout: {"ok":true,"platform":...,"profile":...,"account_id":...}
        or {"ok":false,"error":...}  (exit 1)
"""

from __future__ import annotations

import json
import os
import sys

_WEIXIN_DM_POLICIES = {"pairing", "open", "allowlist", "disabled"}
_WEIXIN_GROUP_POLICIES = {"open", "disabled", "allowlist"}
_QQBOT_DM_POLICIES = {"pairing", "open", "allowlist"}


def main() -> None:
    body = json.load(sys.stdin)
    platform = str(body.get("platform") or "")
    profile = str(body.get("profile") or "default")
    credentials = body.get("credentials") or {}
    options = body.get("options") or {}

    from hermes_cli.config import remove_env_value, save_env_value
    from hermes_cli.web_server_messaging import _write_platform_enabled
    from hermes_cli.web_server_profiles import _profile_scope

    with _profile_scope(profile):
        if platform == "weixin":
            account_id = str(credentials.get("account_id") or "").strip()
            token = str(credentials.get("token") or "").strip()
            if not account_id or not token:
                raise ValueError("扫码会话没有返回完整的 iLink 凭据")
            base_url = str(credentials.get("base_url") or "").strip() or "https://ilinkai.weixin.qq.com"
            user_id = str(credentials.get("user_id") or "").strip()

            from hermes_constants import get_hermes_home
            from gateway.platforms.weixin import save_weixin_account
            save_weixin_account(str(get_hermes_home()),
                                account_id=account_id, token=token,
                                base_url=base_url, user_id=user_id)

            save_env_value("WEIXIN_ACCOUNT_ID", account_id)
            save_env_value("WEIXIN_TOKEN", token)
            save_env_value("WEIXIN_BASE_URL", base_url)
            save_env_value("WEIXIN_CDN_BASE_URL",
                          os.environ.get("WEIXIN_CDN_BASE_URL") or "https://novac2c.cdn.weixin.qq.com/c2c")

            dm_policy = str(options.get("dm_policy") or "pairing")
            if dm_policy not in _WEIXIN_DM_POLICIES:
                raise ValueError("无效的微信私信访问策略")
            allowed_users = str(options.get("allowed_users") or "").replace(" ", "")
            if dm_policy == "allowlist" and not allowed_users:
                raise ValueError("微信「仅指定用户」时必须填写用户 ID")
            save_env_value("WEIXIN_DM_POLICY", dm_policy)
            save_env_value("WEIXIN_ALLOW_ALL_USERS", "true" if dm_policy == "open" else "false")
            save_env_value("WEIXIN_ALLOWED_USERS", allowed_users if dm_policy == "allowlist" else "")

            group_policy = str(options.get("group_policy") or "disabled")
            if group_policy not in _WEIXIN_GROUP_POLICIES:
                raise ValueError("无效的微信群聊策略")
            save_env_value("WEIXIN_GROUP_POLICY", group_policy)
            save_env_value("WEIXIN_GROUP_ALLOWED_USERS",
                           str(options.get("group_allowed_users") or "").replace(" ", "")
                           if group_policy == "allowlist" else "")

            home_channel = str(options.get("home_channel") or "").strip()
            if home_channel:
                save_env_value("WEIXIN_HOME_CHANNEL", home_channel)
            else:
                remove_env_value("WEIXIN_HOME_CHANNEL")
            _write_platform_enabled("weixin", True)
            account_id_out = account_id

        elif platform == "qqbot":
            app_id = str(credentials.get("app_id") or "").strip()
            client_secret = str(credentials.get("client_secret") or "").strip()
            if not app_id or not client_secret:
                raise ValueError("扫码会话没有返回完整的 QQ 机器人凭据")

            save_env_value("QQ_APP_ID", app_id)
            save_env_value("QQ_CLIENT_SECRET", client_secret)

            dm_policy = str(options.get("dm_policy") or "pairing")
            if dm_policy not in _QQBOT_DM_POLICIES:
                raise ValueError("无效的 QQ 私信访问策略")
            allowed_users = str(options.get("allowed_users") or "").replace(" ", "")
            if dm_policy == "allowlist" and not allowed_users:
                raise ValueError("QQ「仅指定用户」时必须填写用户 OpenID")
            save_env_value("QQ_ALLOW_ALL_USERS", "true" if dm_policy == "open" else "false")
            save_env_value("QQ_ALLOWED_USERS", allowed_users if dm_policy == "allowlist" else "")

            home_channel = str(options.get("home_channel") or "").strip()
            if home_channel:
                save_env_value("QQBOT_HOME_CHANNEL", home_channel)
            else:
                remove_env_value("QQBOT_HOME_CHANNEL")
            _write_platform_enabled("qqbot", True)
            account_id_out = app_id

        else:
            raise ValueError("不支持的平台")

    print(json.dumps({
        "ok": True, "platform": platform, "profile": profile,
        "account_id": account_id_out,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
