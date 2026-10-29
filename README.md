# Obsidian Git Plugin

A powerful community plugin for [Obsidian.md](https://obsidian.md) that brings Git integration right into your vault. Automatically commit, pull, push, and see your changes — all within Obsidian.

## Maintained edition

This is the independently maintained `hanshou101` edition of Obsidian Git, based on upstream 2.42.0 (commit `31621dd04cac27dad9537ea2a828f0048366da1b`; see [MAINTENANCE.md](MAINTENANCE.md#upstream-base)). This repository is the primary source for its development, releases, and pull-request merges. The original [`Vinzent03/obsidian-git`](https://github.com/Vinzent03/obsidian-git) repository is kept as an `upstream` reference; its changes are reviewed and merged selectively, never automatically. See [MAINTENANCE.md](MAINTENANCE.md) for the repository policy.

Differences from upstream 2.42.0:

- **Mobile pushes after a merge send only the new commits.** On mobile, a pull that merges remote changes made the next push walk to the root commit and upload the whole history again. In a test vault of about 450 commits (a copy of a real notes repository), that push carried 4,065 objects (14.3 MiB) and commit-and-sync took 19 s on an Android emulator; with this edition it carries 6 objects (3.4 KB) and takes 5 s. The fix is isomorphic-git [PR #2458](https://github.com/isomorphic-git/isomorphic-git/pull/2458), applied to the bundled isomorphic-git 1.44.3 as a pnpm patch until an isomorphic-git release contains it.
- **Manual commits can follow the auto commit globs.** With **Settings → Git (Maintained) → Automatic → Use these globs for manual commits too** turned on, commit-and-sync and the other manual commits stage only the files the auto commit globs select, like the automatic routine. Files you stage yourself are still committed. It is off by default.
- **Its own plugin id, `git-maintained`.** Obsidian offers updates only for plugin ids in its community plugin list, and with the stock id `obsidian-git` it would offer each newer upstream release as an update that replaces this edition. `git-maintained` is not in that list, so Obsidian never offers an update over this edition. The edition does not run while the stock plugin is enabled in the same vault, and on its first start it copies the stock plugin's settings (see below).

### Installing this edition

Each release publishes `main.js`, `manifest.json`, and `styles.css`.

- **With BRAT** (an Obsidian community plugin, installed inside Obsidian like any other plugin): open BRAT's settings, choose **Add beta plugin**, enter `hanshou101/obsidian-git-Maintained`, pick a specific release under **Select a version**, and choose **Add plugin**. A release picked this way is frozen: BRAT does not update it on its own.
- **Manually:** copy the three files from a [release](../../releases) into `<your vault>/.obsidian/plugins/git-maintained/` and restart Obsidian. On Android, a vault created in **App storage** lives under `Android/data/md.obsidian/`, which other apps such as file managers cannot open, so use BRAT there.

#### Switching from the stock Git plugin

1. In **Settings → Community plugins**, turn off **Git** (the stock plugin, id `obsidian-git`). The two plugins register the same views and would sync the same repository, so while the stock plugin is enabled, this edition shows a notice and does nothing else. If you turned this edition on first, turn it off and on again after turning off Git.
2. Install and turn on **Git (Maintained)**. On its first start in a vault, it copies the stock plugin's settings: the stock `data.json` and the values the stock plugin keeps on this device (username, hostname, Git path, additional PATH entries, environment variables, and the times of the last automatic pull, commit-and-sync and push). A notice confirms the copy. It does not copy **Disable on this device** or a pause set with **Pause/Resume automatic routines**. The stock files are left as they are; uninstall Git once this edition works.
3. Bind your hotkeys again, and re-add any commands you put in the mobile toolbar: Obsidian prefixes command ids with the plugin id, so the stock `obsidian-git:push` is `git-maintained:push` here. The command palette lists the commands as "Git (Maintained): …".

Open Source Control and History panes keep working: the view types are the same as the stock plugin's. On mobile, the Git password carries over too: the setting **Git server password or access token** names a secret that Obsidian stores on the device for the vault, and that name is copied with the settings.

### Where this edition is documented

- This README: what the edition changes and how to install it. The rest of the README and [`docs/`](docs) are the upstream user documentation.
- [MAINTENANCE.md](MAINTENANCE.md): repository roles, the dependency patch, versioning, validation, releases, and how the edition reaches the HugeRepo collection.
- [AGENTS.md](AGENTS.md): source layout and coding conventions.
- [CHANGELOG.md](CHANGELOG.md): release notes.
- `.frac.md` in every directory: a fractal context summary (in Chinese) of that directory's own files and its subdirectories' `.frac.md`, starting from the root [`.frac.md`](.frac.md). They follow the [frac-context skill](https://github.com/hanshou101/Obsidian_PublicGitHubShare_InsteadOf_FeiShu/blob/main/3%E3%80%81%E5%90%84%E7%A7%8DSkill%EF%BC%88%E5%BF%AB%E9%80%9F%E5%88%86%E4%BA%AB%EF%BC%9BToAI%EF%BC%9A%E8%AF%B7%E6%8C%89%E9%9C%80%E7%BC%93%E5%AD%98%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC%E5%88%B0%E6%9C%AC%E5%9C%B0%EF%BC%89/%E5%88%86%E5%BD%A2%E4%B8%8A%E4%B8%8B%E6%96%87%E7%B3%BB%E7%BB%9F-%E5%89%8D%E6%9C%9F%E8%AE%A8%E8%AE%BA/frac-context-kit/.claude/skills/frac-context/SKILL.md); after changing files, refresh the affected `.frac.md` from the deepest directory up to the root.

## 📚 Documentation

All setup instructions (including mobile), common issues, tips, and advanced configuration can be found in the 📖 [full documentation](https://publish.obsidian.md/git-doc).

For a pull or sync stopped by conflicting changes, see [Conflict resolution](https://publish.obsidian.md/git-doc/Conflict+resolution).

> Mobile users: The plugin is **highly unstable ⚠️ !** Please check the dedicated [Mobile](#-mobile-support-%EF%B8%8F--experimental) section below.

## Key Features

- 🔁 **Automatic commit-and-sync** (commit, pull, and push) on a schedule.
- 📥 **Auto-pull on Obsidian startup**
- 📂 **Submodule support** for managing multiple repositories (desktop only and opt-in)
- 🔧 **Source Control View** to stage/unstage, commit and diff files - Open it with the `Open source control view` command.
- 📜 **History View** for browsing commit logs and changed files - Open it with the `Open history view` command.
- 🔍 **Diff View** for viewing changes in a file - Open it with the `Open diff view` command.
- 📝 **Signs in the editor** to indicate added, modified, and deleted lines/hunks (desktop only).
- GitHub integration to open files and history in your browser

> For detailed file history, consider pairing this plugin with the [Version History Diff](obsidian://show-plugin?id=obsidian-version-history-diff) plugin.

## UI Previews

### 🔧 Source Control View

Manage your file changes directly inside Obsidian, including staging and unstaging individual files and committing them. The main Commit action commits staged changes when present. If nothing is staged, the `Stage all changes when nothing is staged` setting determines whether all changes are staged and committed. The actions menu provides explicit staged-only and all-changes alternatives, plus amending the previous commit on desktop.

![Source Control View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/source-view.png)

### 📜 History View

Show the commit history of your repository. The commit message, author, date, and changed files can be shown. Author and date are disabled by default as shown in the screenshot, but can be enabled in the settings.

![History View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/history-view.png)

### 🔍 Diff View 

Compare versions with a clear and concise diff viewer.
Open it from the source control view or via the `Open diff view` command.

![Diff View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/diff-view.png)

### 📝 Signs in the Editor

View line-by-line changes directly in the editor with added, modified, and deleted line/hunk indicators. You can stage and reset changes right from the signs. There also commands to navigate between hunks and stage/reset hunks under the cursor. Needs to be enabled in the plugin settings.

![Signs](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/signs.png)

## Available Commands
> Not exhaustive - these are just some of the most common commands. For a full list, see the Command Palette in Obsidian.

- 🔄 Changes
  - `List changed files`: Lists all changes in a modal
  - `Open diff view`: Open diff view for the current file
  - `Stage current file`
  - `Unstage current file`
  - `Discard all changes`: Discard all changes in the repository
- ✅ Commit
  - `Commit`: Commits staged changes when present. If nothing is staged, either stages and commits all changes or stops, depending on the `Stage all changes when nothing is staged` setting
  - `Commit with specific message`: Same as above, but with a custom message
  - `Commit all changes`: Commits all changes without pushing
  - `Commit all changes with specific message`: Same as above, but with a custom message
- 🔀 Commit-and-sync
  - `Commit-and-sync`: With default settings, this will commit all changes, pull, and push
  - `Commit-and-sync with specific message`: Same as above, but with a custom message
  - `Commit-and-sync and close`: Same as `Commit-and-sync`, but if running on desktop, will close the Obsidian window. Will not exit Obsidian app on mobile.
- 🌐 Remote
  - `Push`, `Pull`
  - `Edit remotes`: Add new remotes or edit existing remotes
  - `Remove remote`
  - `Clone an existing remote repo`: Opens dialog that will prompt for URL and authentication to clone a remote repo
  - `Open file on GitHub`: Open the file view of the current file on GitHub in a browser window. Note: only works on desktop
  - `Open file history on GitHub`: Open the file history of the current file on GitHub in a browser window. Note: only works on desktop
- 🏠 Manage local repository
  - `Initialize a new repo`
  - `Create new branch`
  - `Delete branch`
  - `CAUTION: Delete repository`
- 🧪 Miscellaneous
  - `Open source control view`: Opens side pane displaying [Source control view](#sidebar-view)
  - `Open history view`: Opens side pane displaying [History view](#history-view)
  - `Edit .gitignore`
  - `Add file to .gitignore`: Add current file to `.gitignore`

## 💻 Desktop Notes

### 🔐 Authentication

Some Git services may require further setup for HTTPS/SSH authentication. Refer to the [Authentication Guide](https://publish.obsidian.md/git-doc/Authentication)

### Obsidian on Linux

- ⚠️  Snap is not supported due to its sandboxing restrictions.
- ⚠️  Flatpak is not recommended, because it doesn't have access to all system files. They are actively fixing many issues, but there are still issues. Especially with more advanced setups.
- ✅ Please use AppImage or a full access installation of your system's package manager instead ([Linux installation guide](https://publish.obsidian.md/git-doc/Installation#Linux))

## 📱 Mobile Support (⚠️  Experimental)

The Git implementation on mobile is **very unstable**! I would not recommend using this plugin on mobile, but try other syncing services.

One such alternative is [GitSync](https://github.com/ViscousPot/GitSync), which is available on both Android and iOS. It is not associated with this plugin, but it may be a better option for mobile users. A tutorial for setting it up can be found [here](https://viscouspotenti.al/posts/gitsync-all-devices-tutorial).

> 🧪 The Git plugin works on mobile thanks to [isomorphic-git](https://isomorphic-git.org/), a JavaScript-based re-implementation of Git - but it comes with serious limitations and issues. It is not possible for an Obsidian plugin to use a native Git installation on Android or iOS.

### ❌ Mobile Feature Limitations

- No **SSH authentication** ([isomorphic-git issue](https://github.com/isomorphic-git/isomorphic-git/issues/231))
- Limited repo size, because of memory restrictions
- No rebase merge strategy
- No submodules support

### ⚠️ Performance Caveats

> [!caution]
> Depending on your device and available free RAM, Obsidian may
>
> - crash on clone/pull
> - create buffer overflow errors
> - run indefinitely.
>
> It's caused by the underlying git implementation on mobile, which is not efficient. I don't know how to fix this. If that's the case for you, I have to admit this plugin won't work for you. So commenting on any issue or creating a new one won't help. I am sorry.

### Tips for Mobile Use:

If you have a large repo/vault I recommend staging individual files and setting automatic commit globs to Include matches with an empty list, so automatic commits use only staged files.

## 🙋 Contact & Credits

- The Line Authoring feature was developed by [GollyTicker](https://github.com/GollyTicker), so any questions may be best answered by her.
- This plugin was initial developed by [denolehov](https://github.com/denolehov). Since March 2021, it's me [Vinzent03](https://github.com/Vinzent03) who is developing this plugin. That's why the GitHub repository got moved to my account in July 2024.
- If you have any kind of feedback or questions, feel free to reach out via GitHub issues.

## ☕ Support

If you find this plugin useful and would like to support its development, you can support me on Ko-fi.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F195IQ5)
