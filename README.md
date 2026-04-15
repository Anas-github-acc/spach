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

## Architecture Diagram

```mermaid
flowchart TD
	A[User presses Alt+g] --> B{Page Type Router}
	B -->|Moodle page| C[Extract active question + detect type]
	B -->|Google Form page| D[Extract visible form questions + types]

	C --> E{Question type}
	E -->|Choice| F[Build choice prompt]
	E -->|Short answer| G[Build short-answer prompt]

	D --> H[Build compact multi-question prompt]

	F --> I[Gemini request pipeline<br/>model/key fallback + backoff]
	G --> I
	H --> I

	I --> J[Parse AI response]
	J -->|Moodle| K[Apply answer to current question]
	J -->|Google Forms| L[Apply answers to form fields/options]

	K --> M[Done + logs]
	L --> M
```

## Setup

To get started, clone this repository and open `config.js`. Add your primary API key in the `apiKey` field:

```js
const apiKey = "YOUR_API_KEY";
```

You can also add fallback keys and adjust model names in the same file if needed. After configuration, open your browser's extension page (for example, `chrome://extensions`), enable Developer mode, and choose Load unpacked to load this project folder. Once loaded, open a supported Moodle or Google Forms quiz page and use the extension.

## Roadmap

We plan to add local model support in a future release so users can run Spach with more flexibility and reduced dependency on cloud APIs.
