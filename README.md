# Spach

[![GitHub Stars](https://img.shields.io/github/stars/Anas-github-acc/spach?style=social)](https://github.com/Anas-github-acc/spach/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/Anas-github-acc/spach?style=social)](https://github.com/Anas-github-acc/spach/network/members)
[![GitHub Contributors](https://img.shields.io/github/contributors/Anas-github-acc/spach?style=flat-square&label=GitHub%20Contributors&color=2ea44f)](https://github.com/Anas-github-acc/spach/graphs/contributors)

Spach is a browser extension designed to help solve online quizzes. It currently supports Moodle and Google Forms, where it reads questions directly from the page and uses AI to choose and fill the most likely correct answers.

The goal of Spach is to make quiz assistance fast and practical inside the browser, without requiring users to copy and paste questions manually.



## How It Works

When you open a supported quiz page, the extension detects visible questions, sends the relevant context to an AI model, and then fills in the predicted answers automatically.

## Unified Trigger

Spach now uses a single shortcut across supported pages:

- `Alt + g`

What happens when you press `Alt + g`:

- On Moodle: it extracts the current question, detects its type (`choice` or `short-answer`), asks AI for the answer, and fills the result.
- On Google Forms: it extracts visible questions in the current chunk, asks AI for structured answers, and fills them.


## Setup

To get started, clone this repository and open `config.js`.

### OpenCode server

Spach uses OpenCode as its only AI backend. Configure the OpenCode server and model values:

```js
const openCodeBaseUrl = "http://127.0.0.1:4096";
const openCodeApiKey = ""; // optional Bearer token for a protected server
const MODEL_PREFERENCES = [
  "opencode/nemotron-3-ultra-free", // Model 1
  "opencode/mimo-v2.5-free", // Model 2
  "opencode/nemotron-3.5-lightning-free" // Model 3
];
```

Each model is a `provider/model` string. The array position is its model number.

Start the OpenCode server with:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

If the `opencode` command is not available through your shell, use the installed binary path:

```bash
/home/anas/.local/share/mise/installs/opencode/1.18.29/opencode serve --hostname 127.0.0.1 --port 4096
```

OpenCode provider credentials are normally configured separately with `opencode auth login`.
The `openCodeApiKey` setting is only for a Bearer token required by a protected HTTP server;
it is not a model/provider API key. For a local server without HTTP authentication, leave it empty.

To test a model directly from the terminal, start the server first and run:

```bash
node scripts/test-opencode-model.js opencode/nemotron-3-ultra-free
```

Replace the model name to test Model 2 or Model 3. You can also test the active model from
the Moodle page by opening DevTools and running `testModelConnection()` in the console.

Model selection shortcuts:

- `Alt + 1`, `Alt + 2`, `Alt + 3` select the corresponding model from `MODEL_PREFERENCES`.
- The selected model remains the starting model for later requests.
- If it fails, the other configured models are tried in cyclic order once each.

Start your OpenCode SDK server before using the extension, then load the extension as usual.

After configuration, open your browser's extension page (for example, `chrome://extensions`), enable Developer mode, and choose Load unpacked to load this project folder. Once loaded, open a supported Moodle or Google Forms quiz page and use the extension.

## Roadmap

We plan to add local model support in a future release so users can run Spach with more flexibility and reduced dependency on cloud APIs.
