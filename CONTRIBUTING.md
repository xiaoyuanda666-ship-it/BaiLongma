# Contributing to Bailongma

Thank you for your interest in contributing to Bailongma! This guide will help you get started.

## Development Environment

- **Node.js**: v18 or higher (recommend using [nvm](https://github.com/nvm-sh/nvm) for version management)
- **OS**: Windows x64 / macOS (x64+arm64) / Linux x64
- **Git**: Latest version

## Getting Started

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/<your-username>/BaiLongma.git
cd BaiLongma

# 3. Install dependencies
npm install

# 4. Start the application
npm start          # Electron desktop app
npm run dev        # Backend only with auto-restart

# 5. Create a feature branch
git checkout -b feature/your-feature-name
```

## Code Style

This project uses ESLint and Prettier for code formatting.

```bash
# Check for lint errors
npx eslint src/

# Auto-fix lint errors
npx eslint src/ --fix

# Format code
npx prettier --write "src/**/*.{js,mjs}"
```

### Style Guidelines

- Use ES Modules (`import`/`export`) — the project uses `"type": "module"`
- Use `camelCase` for variables and functions
- Use `PascalCase` for classes and constructors
- Prefer `const` over `let`, avoid `var`
- Use meaningful variable names
- Keep functions focused and small (ideally < 100 lines)
- Add JSDoc comments for exported functions

## Testing

Run tests before submitting a PR:

```bash
# Smoke tests
npm run smoke:tools
npm run smoke:brain-ui
npm run smoke:social

# Unit/integration tests
npm run test:rule-context
npm run test:complex-task
npm run test:relevance
npm run test:agent-skills
npm run test:config-upgrade
```

## Branch Naming

Use descriptive branch names:

| Prefix | Purpose |
|--------|---------|
| `feature/` | New features |
| `fix/` | Bug fixes |
| `infra/` | Infrastructure and tooling |
| `docs/` | Documentation changes |
| `refactor/` | Code refactoring |

## Commit Messages

Write clear, concise commit messages:

```
type(scope): brief description

- detail 1
- detail 2
```

Types: `feat`, `fix`, `infra`, `docs`, `refactor`, `test`, `chore`

## Pull Request Process

1. Ensure your code follows the style guidelines
2. Run all relevant tests
3. Update documentation if needed
4. Fill out the PR template completely
5. Link any related issues

### PR Title Format

```
type(scope): brief description
```

Example: `feat(memory): add semantic deduplication for long-term memories`

## Reporting Issues

- Use the Bug Report template for bugs
- Use the Feature Request template for suggestions
- Include reproduction steps for bugs
- Include your OS, Node.js version, and npm version

## Code of Conduct

- Be respectful and constructive
- Focus on the code, not the person
- Welcome newcomers and help them learn
- Accept feedback gracefully

## Questions?

Open a Discussion or reach out to the maintainers.
