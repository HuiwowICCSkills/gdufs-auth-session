# GDUFS session model

## Session file

Default path:

- Windows: `%USERPROFILE%\.gdufs-auth\session.json`
- macOS/Linux: `~/.cache/gdufs-auth/session.json`

Override with `--session` or `GDUFS_AUTH_SESSION`.

Shape:

```json
{
  "version": 1,
  "saved_at": "YYYY-MM-DDTHH:MM:SSZ",
  "username_masked": "202****",
  "cookies": [
    {
      "name": "vpn-cookie",
      "value": "<redacted>",
      "domain": ".libvpn.gdufs.edu.cn",
      "path": "/",
      "secure": true,
      "expires": null
    }
  ],
  "vpn_status": {"code": 200, "msg": "false", "islogin": "true"}
}
```

The session file is a bearer credential. It is written atomically and, on POSIX systems, with mode `0600`. Do not commit it or paste it into reports.

## Session limit and lock

The auth helper uses `<session>.lock` around login. Concurrent callers wait for the lock; stale locks older than 240 seconds are removed. Callers should use `ensure`, not concurrent `login` calls.

## Validation

`status` restores cookies and calls the VPN portal's public `ipissuccess` endpoint. `islogin=true` is the only success condition. HTTP success alone is not treated as a valid session.

## Credentials

Credentials never enter the session file. They come from `--config`, `GDUFS_AUTH_CONFIG`, `GDUFS_USERNAME` or `GDUFS_PASSWORD`. The config JSON can contain:

```json
{
  "username": "<account>",
  "password": "<password>",
  "verify_ssl": true,
  "timeout_seconds": 30
}
```

Keep the config outside the repository and restrict its permissions.

## Browser-assisted sources

`headless_fetch.mjs` consumes the cookie JSON output. It does not modify the session. A research skill should:

1. call `ensure`;
2. call `cookies --out <temporary file>`;
3. invoke `headless_fetch.mjs`;
4. parse the rendered HTML;
5. delete the temporary cookie file.

If the target site returns a manual security challenge or explicitly rejects automation, report that limitation instead of trying to bypass it.

## Browser-source preference

The session skill remembers one browser-source decision per Codex session:

- key: `CODEX_THREAD_ID`, or a fingerprint of the current GDUFS session when no Codex thread id is available;
- file: `<user cache>/gdufs-auth/browser_sources.json`;
- commands: `browser-preference get|set|reset`.

Research skills call `get` before their first search. If the preference is unset, they return a `needs_user_input` prompt instead of choosing silently. After the user answers, the assistant calls `set --enabled true|false` and reruns the search. The decision persists for the rest of that Codex session; a new session or a new GDUFS session asks again.

## Failure modes

- `missing`: no session file; call `login` or `ensure`.
- `expired`: VPN reports `islogin=false`; call `login` or `ensure`.
- `error`: credential, network, or SSO schema failure; preserve the error and do not infer that the target resource is unavailable.
- Browser failure: Chrome/Chromium missing, Node missing, Service Worker registration failure, or target-side challenge. Report the exact stage.
