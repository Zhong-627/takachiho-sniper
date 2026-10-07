import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
 { ignores: ['node_modules/**', 'artifacts/**', 'dist/**', '.local/**'] },
 js.configs.recommended,
 ...tseslint.configs.recommended,
 { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
 { files: ['**/*.js'], languageOptions: { sourceType: 'module' } }
);
