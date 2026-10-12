DELETE FROM models WHERE (provider, model_id) IN (
  ('openrouter', 'openrouter/some-model:free'),
  ('openrouter', 'openrouter/some-other-model'),
  ('gemini', 'gemini/some-preview-model')
);
