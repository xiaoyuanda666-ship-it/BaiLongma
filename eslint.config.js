import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        // Electron globals
        electron: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Browser globals (for Brain UI)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        requestIdleCallback: 'readonly',
        cancelIdleCallback: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        Video: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        WebSocket: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        crypto: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-constant-condition': 'warn',
      'no-debugger': 'warn',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-extra-semi': 'warn',
      'no-redeclare': 'error',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-loss-of-precision': 'warn',
      'no-promise-executor-return': 'warn',
      'no-self-compare': 'warn',
      'no-template-curly-in-string': 'warn',
      'no-unmodified-loop-condition': 'warn',
      'no-useless-assignment': 'warn'
    }
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'data/',
      'sandbox/',
      '**/*.min.js',
      'src/ui/brain-ui/vendor/',
      '**/vendor/'
    ]
  }
];
