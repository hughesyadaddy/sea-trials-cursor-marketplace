#!/usr/bin/env bash
# Local parity for secrets-scripts-tests (mirrors pr-checks.yml).
# Ships in the sea-trials plugin; runs against the checkout in cwd.
set -euo pipefail

ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

node --test scripts/setup-secrets.test.mjs \
  scripts/generate-firebase-configs.test.mjs \
  scripts/ci-workflows.test.mjs \
  scripts/setup-secrets-firebase-refresh.test.mjs \
  scripts/env-key-map.test.mjs \
  scripts/secrets-backend-neon.test.mjs \
  scripts/env-parity/tests/parity-common.test.mjs \
  scripts/env-parity/tests/parity-classify.test.mjs \
  scripts/env-parity/tests/parity-cli.test.mjs \
  scripts/remove-secrets-from-history.test.mjs \
  scripts/required-keys-parity.test.mjs \
  scripts/lib/envfile.test.mjs \
  scripts/lib/flavors.test.mjs \
  scripts/lib/urls.test.mjs \
  scripts/register_android_debug_sha.test.mjs \
  scripts/lib/google-access-token.test.mjs

bash code_magic_whitelabel_builder/tests/test_flutterfire_configure_helper.sh
bash code_magic_whitelabel_builder/tests/test_firebase_utils_helper_delegation.sh
bash code_magic_whitelabel_builder/tests/test_deploy_supabase_export.sh
bash code_magic_whitelabel_builder/tests/test_writeback_system_config.sh
bash code_magic_whitelabel_builder/tests/test_writeback_post.sh

node --test scripts/web_load_watchdog.test.mjs

bash -n scripts/setup-secrets.sh
shellcheck --severity=warning --exclude=SC2178 scripts/setup-secrets.sh
bash -n code_magic_whitelabel_builder/utils/flutterfire_configure.sh
shellcheck --severity=warning code_magic_whitelabel_builder/utils/flutterfire_configure.sh
bash -n code_magic_whitelabel_builder/platform/marketing/assert_no_dotsecrets.sh
shellcheck --severity=warning \
  code_magic_whitelabel_builder/platform/marketing/assert_no_dotsecrets.sh
bash -n scripts/lib/envfile.sh
shellcheck --severity=warning scripts/lib/envfile.sh
bash -n scripts/lib/flavors.sh
shellcheck --severity=warning scripts/lib/flavors.sh
bash -n scripts/lib/urls.sh
shellcheck --severity=warning scripts/lib/urls.sh

bash code_magic_whitelabel_builder/tests/test_web_env_contract.sh
bash code_magic_whitelabel_builder/tests/test_deploy_marketing_source_selection.sh
bash code_magic_whitelabel_builder/tests/test_codemagic_marketing_wiring.sh
bash code_magic_whitelabel_builder/tests/test_assert_no_dotsecrets.sh
bash code_magic_whitelabel_builder/tests/test_generate_web_env_golden.sh
bash code_magic_whitelabel_builder/tests/test_web_env_equivalence.sh
bash code_magic_whitelabel_builder/tests/test_marketing_web_env_utils_local.sh
bash scripts/supabase/test_resolve_pooler_db_url.sh
