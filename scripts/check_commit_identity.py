#!/usr/bin/env python3
"""Validate commit authors, committers, and co-author trailers for a GitHub PR."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

NAME = "Mojtaba Arvin"
EMAIL = "m.arvin@live.com"
LOGIN = "mojtaba-arvin"
MARKER = "<!-- maintainer-directed-ai-work -->"
AUTO_LABEL = "allow-automation-commits"
AUTO_LOGINS = {"github-actions[bot]", "dependabot[bot]"}
BOT_MARKERS = re.compile(
    r"\[bot\]|\b(?:ai[\s_-]*agent|agent[\s_-]*bot|ai[\s_-]*assistant|"
    r"assistant[\s_-]*bot|copilot|claude|cursor|windsurf|codex|"
    r"chatgpt|gemini|openai|gpt)\b",
    re.IGNORECASE,
)


def is_bot(name, email, login=None, account_type=None):
    if (account_type or "").lower() == "bot":
        return True
    if login and login.lower().endswith("[bot]"):
        return True
    return bool(BOT_MARKERS.search(" ".join((name or "", email or "", login or ""))))


def identity(account):
    account = account or {}
    return account.get("login"), account.get("type")


def validate(pr, commits):
    errors = []
    labels = {item.get("name", "") for item in pr.get("labels", [])}
    allow_auto = AUTO_LABEL in labels
    maintainer_work = MARKER in (pr.get("body") or "")
    maintainer_commit_seen = False

    for item in commits:
        commit = item.get("commit") or {}
        author = commit.get("author") or {}
        committer = commit.get("committer") or {}
        author_login, author_type = identity(item.get("author"))
        committer_login, committer_type = identity(item.get("committer"))
        author_name = author.get("name") or ""
        author_email = author.get("email") or ""
        committer_name = committer.get("name") or ""
        committer_email = committer.get("email") or ""
        sha = (item.get("sha") or "unknown")[:12]

        if not author_name or not author_email:
            errors.append(sha + ": missing author name/email")
        if not committer_name or not committer_email:
            errors.append(sha + ": missing committer name/email")

        author_is_bot = is_bot(author_name, author_email, author_login, author_type)
        committer_is_bot = is_bot(
            committer_name, committer_email, committer_login, committer_type
        )
        genuine_automation = (
            allow_auto
            and author_login in AUTO_LOGINS
            and author_login == committer_login
            and author_type == "Bot"
            and committer_type == "Bot"
            and author_is_bot
            and committer_is_bot
            and author_name == committer_name
            and author_email.lower() == committer_email.lower()
        )

        if author_is_bot and not genuine_automation:
            errors.append(
                f"{sha}: bot/agent author rejected: "
                f"{author_name!r} <{author_email}> login={author_login!r}"
            )
        if committer_is_bot and not genuine_automation:
            errors.append(
                f"{sha}: bot/agent committer rejected: "
                f"{committer_name!r} <{committer_email}> "
                f"login={committer_login!r}"
            )

        if author_login == LOGIN:
            maintainer_commit_seen = True
            if author_name != NAME or author_email.lower() != EMAIL.lower():
                errors.append(
                    f"{sha}: maintainer author must use {NAME} <{EMAIL}>, "
                    f"got {author_name!r} <{author_email}>"
                )
        elif author_email.lower() == EMAIL.lower():
            errors.append(
                f"{sha}: maintainer email must resolve to {LOGIN}, "
                f"not {author_login!r}"
            )

        if committer_login == LOGIN and (
            committer_name != NAME or committer_email.lower() != EMAIL.lower()
        ):
            errors.append(
                f"{sha}: maintainer committer must use {NAME} <{EMAIL}>, "
                f"got {committer_name!r} <{committer_email}>"
            )
        elif committer_email.lower() == EMAIL.lower():
            errors.append(
                f"{sha}: maintainer committer email must resolve to {LOGIN}, "
                f"not {committer_login!r}"
            )

        # GitHub's web-flow account is a transport committer, not the author.
        # Preserve that distinction; do not relabel the human author.
        if committer_login == "web-flow" and committer_is_bot:
            errors.append(f"{sha}: invalid web-flow committer metadata")

        for line in (commit.get("message") or "").splitlines():
            if line.lower().startswith("co-authored-by:"):
                trailer_identity = line.split(":", 1)[1].strip()
                if is_bot(trailer_identity, ""):
                    errors.append(
                        f"{sha}: bot/AI Co-authored-by trailer rejected: "
                        f"{trailer_identity!r}"
                    )

    if maintainer_work and not maintainer_commit_seen:
        errors.append(
            "maintainer-directed AI work marker requires at least one "
            "commit authored by mojtaba-arvin"
        )
    return errors


def get_json(url, token):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "commit-identity-policy-check",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def self_test():
    def item(
        author_name,
        author_email,
        author_login,
        author_type,
        message="feat: test",
        committer_name=None,
        committer_email=None,
        committer_login=None,
        committer_type="User",
    ):
        return {
            "sha": "a" * 40,
            "commit": {
                "author": {"name": author_name, "email": author_email},
                "committer": {
                    "name": committer_name or author_name,
                    "email": committer_email or author_email,
                },
                "message": message,
            },
            "author": {"login": author_login, "type": author_type}
            if author_login
            else None,
            "committer": {
                "login": committer_login or author_login,
                "type": committer_type,
            }
            if (committer_login or author_login)
            else None,
        }

    no_labels = {"body": "", "labels": []}
    assert not validate(
        no_labels, [item(NAME, EMAIL, LOGIN, "User")]
    )
    assert not validate(
        no_labels,
        [item("External Human", "x@example.org", "human", "User")],
    )
    assert not validate(
        no_labels,
        [
            item(
                "External Human",
                "x@example.org",
                "human",
                "User",
                committer_name="GitHub",
                committer_email="noreply@github.com",
                committer_login="web-flow",
            )
        ],
    )
    assert validate(
        no_labels, [item("Copilot", "bot@example.org", "copilot[bot]", "Bot")]
    )
    assert validate(
        no_labels,
        [
            item(
                "External Human",
                "x@example.org",
                "human",
                "User",
                committer_name="github-actions[bot]",
                committer_email="bot@users.noreply.github.com",
                committer_login="github-actions[bot]",
                committer_type="Bot",
            )
        ],
    )
    bot_trailer = (
        "feat: test\nCo-authored-by: Copilot "
        "<copilot[bot]@users.noreply.github.com>"
    )
    assert validate(
        no_labels,
        [item("External Human", "x@example.org", "human", "User", bot_trailer)],
    )
    assert not validate(
        {"body": MARKER, "labels": []},
        [item(NAME, EMAIL, LOGIN, "User")],
    )
    assert not validate(
        {"body": MARKER, "labels": []},
        [
            item(NAME, EMAIL, LOGIN, "User"),
            item("Other Human", "x@example.org", "human", "User"),
        ],
    )
    assert validate(
        {"body": MARKER, "labels": []},
        [item("Other Human", "x@example.org", "human", "User")],
    )
    assert validate(
        no_labels, [item(NAME, "wrong@example.org", LOGIN, "User")]
    )
    assert validate(
        no_labels,
        [
            item(
                "External Human",
                "x@example.org",
                "human",
                "User",
                committer_name=NAME,
                committer_email=EMAIL,
                committer_login="human",
            )
        ],
    )
    automation = item(
        "github-actions[bot]",
        "41898282+github-actions[bot]@users.noreply.github.com",
        "github-actions[bot]",
        "Bot",
        committer_name="github-actions[bot]",
        committer_email="41898282+github-actions[bot]@users.noreply.github.com",
        committer_login="github-actions[bot]",
        committer_type="Bot",
    )
    assert not validate(
        {"body": "", "labels": [{"name": AUTO_LABEL}]}, [automation]
    )
    assert validate(
        no_labels, [automation]
    )
    dependabot = item(
        "dependabot[bot]",
        "49699333+dependabot[bot]@users.noreply.github.com",
        "dependabot[bot]",
        "Bot",
        committer_name="dependabot[bot]",
        committer_email="49699333+dependabot[bot]@users.noreply.github.com",
        committer_login="dependabot[bot]",
        committer_type="Bot",
    )
    assert not validate(
        {"body": "", "labels": [{"name": AUTO_LABEL}]}, [dependabot]
    )
    assert validate(no_labels, [dependabot])
    mismatched_automation = item(
        "github-actions[bot]",
        "41898282+github-actions[bot]@users.noreply.github.com",
        "github-actions[bot]",
        "Bot",
        committer_name=NAME,
        committer_email=EMAIL,
        committer_login=LOGIN,
    )
    assert validate(
        {"body": "", "labels": [{"name": AUTO_LABEL}]},
        [mismatched_automation],
    )
    assert not validate(
        no_labels, [item("GPTools Human", "human@example.org", "human", "User")]
    )
    print("PASS: commit identity policy self-tests")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=os.getenv("GITHUB_REPOSITORY"))
    parser.add_argument(
        "--pr-number", type=int, default=int(os.getenv("PR_NUMBER", "0"))
    )
    parser.add_argument("--token", default=os.getenv("GITHUB_TOKEN"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
    if not (args.repository and args.pr_number and args.token):
        if args.self_test and not args.pr_number:
            return 0
        parser.error("--repository, --pr-number and --token are required")

    base = "https://api.github.com/repos/" + args.repository
    pr = get_json(base + "/pulls/" + str(args.pr_number), args.token)
    commits = []
    page = 1
    while True:
        batch = get_json(
            base + f"/pulls/{args.pr_number}/commits?per_page=100&page={page}",
            args.token,
        )
        if not isinstance(batch, list):
            raise RuntimeError("GitHub API returned a non-list commit response")
        commits.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    if not commits:
        print("ERROR: empty PR commit list; refusing to pass")
        return 2
    errors = validate(pr, commits)
    print(f"Checked {len(commits)} commits in {args.repository}#{args.pr_number}")
    if errors:
        print("\n".join("ERROR: " + error for error in errors))
        return 1
    print("PASS: no prohibited bot/agent authors, committers, or co-author trailers")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        print(
            f"ERROR: GitHub API HTTP {error.code}: {error.reason}",
            file=sys.stderr,
        )
        sys.exit(2)
    except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
        print(f"ERROR: identity validation incomplete: {error}", file=sys.stderr)
        sys.exit(2)
