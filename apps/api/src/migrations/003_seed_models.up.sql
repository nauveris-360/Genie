-- Seed the model registry with the two initially-configurable providers
-- named in BUILD-SPEC.md (OpenRouter, Gemini). Pricing facts here are
-- placeholders pending a real verification job (Codex/ops owns refreshing
-- these against live provider pricing pages); until that job exists, any
-- model not explicitly marked verified_free is correctly treated as
-- non-free by the policy engine, including the "unknown" Gemini preview
-- entry below. The :free suffix is not trusted on its own - a model only
-- gets pricing_status = 'verified_free' here.
INSERT INTO models (provider, model_id, display_name, pricing_status, input_price_per_million_tokens_usd, output_price_per_million_tokens_usd, last_verified_at)
VALUES
  ('openrouter', 'openrouter/some-model:free', 'Some Model (free)', 'verified_free', 0, 0, now()),
  ('openrouter', 'openrouter/some-other-model', 'Some Other Model', 'paid', 3.0, 15.0, now()),
  ('gemini', 'gemini/some-preview-model', 'Some Preview Model', 'unknown', NULL, NULL, NULL)
ON CONFLICT (provider, model_id) DO NOTHING;
