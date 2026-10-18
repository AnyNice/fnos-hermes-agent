"""Apply credentials returned by Hermes' Feishu device-code onboarding.

The Node browser host keeps the App Secret out of the renderer and sends it to
this short-lived helper over stdin. All writes use Hermes' own profile scope,
dotenv writer and platform config writer.
"""

from __future__ import annotations

import json
import sys


def main() -> None:
    body = json.load(sys.stdin)
    profile = str(body.get("profile") or "default")
    credentials = body.get("credentials") or {}
    options = body.get("options") or {}
    app_id = str(credentials.get("app_id") or "").strip()
    app_secret = str(credentials.get("app_secret") or "").strip()
    if not app_id or not app_secret:
        raise ValueError("扫码会话没有返回完整的飞书应用凭据")

    from hermes_cli.config import remove_env_value, save_env_value
    from hermes_cli.web_server_messaging import _write_platform_enabled
    from hermes_cli.web_server_profiles import _profile_scope

    dm_policy = str(options.get("dm_policy") or "pairing")
    if dm_policy not in {"pairing", "open", "allowlist"}:
        raise ValueError("无效的飞书私信授权策略")
    group_policy = str(options.get("group_policy") or "open")
    if group_policy not in {"open", "disabled"}:
        raise ValueError("无效的飞书群聊策略")
    allowed_users = str(options.get("allowed_users") or "").replace(" ", "")
    if dm_policy == "allowlist" and not allowed_users:
        raise ValueError("仅允许指定用户时必须填写飞书用户 ID")

    with _profile_scope(profile):
        save_env_value("FEISHU_APP_ID", app_id)
        save_env_value("FEISHU_APP_SECRET", app_secret)
        save_env_value("FEISHU_DOMAIN", "lark" if credentials.get("domain") == "lark" else "feishu")
        save_env_value("FEISHU_CONNECTION_MODE", "websocket")
        save_env_value("FEISHU_ALLOW_ALL_USERS", "true" if dm_policy == "open" else "false")
        save_env_value("FEISHU_ALLOWED_USERS", allowed_users if dm_policy == "allowlist" else "")
        save_env_value("FEISHU_GROUP_POLICY", group_policy)
        home_channel = str(options.get("home_channel") or "").strip()
        if home_channel:
            save_env_value("FEISHU_HOME_CHANNEL", home_channel)
        else:
            remove_env_value("FEISHU_HOME_CHANNEL")
        _write_platform_enabled("feishu", True)

    print(json.dumps({
        "ok": True,
        "platform": "feishu",
        "profile": profile,
        "app_id": app_id,
        "domain": "lark" if credentials.get("domain") == "lark" else "feishu",
        "bot_name": credentials.get("bot_name") or None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
