-- Non-login share links for a form's submissions/results table (2026-09-18
-- request) -- an admin generates one or more tokenized links per form, each
-- independently 'read' or 'edit', with an optional expiration, so an
-- external stakeholder can view (or, for an 'edit' link, annotate/correct)
-- a form's response data with no SB Net login. 'edit' mirrors exactly what
-- an internal authenticated editor's canWrite flag already permits on
-- FormResultsPage.tsx today -- override a submitted response's value
-- (forms.response_overrides) and edit the admin-added tracking columns
-- (forms.submission_column_values) -- no new capability, just a
-- token-gated path to the same two write actions. Adding a NEW tracking
-- column, deleting a submission, or editing the form itself are NOT
-- reachable through a share link at any permission level.
--
-- Deliberately its own table, not an extension of
-- forms.submission_access_rules -- that table is CHECKed to
-- principal_type IN ('user','department','role','org') and its RLS
-- policies all key off auth.uid()/auth.role() = 'authenticated'; an
-- anonymous token holder has neither, so that mechanism doesn't apply
-- here. And deliberately SECURITY DEFINER RPCs rather than a direct anon
-- table read like PublicFormPage's own fill-out flow (see
-- 20260930af_forms_schema_anon_usage.sql, the same day) -- an RPC never
-- needs the caller's own schema/table privileges, which keeps this
-- feature from ever needing anon granted directly onto
-- forms.responses/submissions/etc., a much smaller surface for a much
-- more sensitive read (real submitted business data) than the public
-- fill-out form needs.
CREATE TABLE forms.submission_shares (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  label text,
  permission text NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'edit')),
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submission_shares_form_idx ON forms.submission_shares (form_id);

ALTER TABLE forms.submission_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "submission_shares_manage" ON forms.submission_shares
  FOR ALL USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  )
  WITH CHECK (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

-- Learned live the same day on forms.forms (20260930af): a table GRANT is
-- checked before RLS ever runs -- a missing one fails as a flat
-- "permission denied for table" regardless of how correct the policy is.
GRANT SELECT, INSERT, UPDATE, DELETE ON forms.submission_shares TO authenticated;

-- Public, no-auth read: everything the shared results table needs to
-- render in one call -- the share's own permission/expiry state, form
-- title, field definitions, submissions, responses, tracking columns +
-- their values, and existing overrides. An explicit column whitelist on
-- every nested object (never to_jsonb(row)), same convention as every
-- other public RPC in this app -- deliberately omits respondent_email and
-- submitted_by/any internal-user identity resolution, since a shared
-- results table is a materially more sensitive read than a public
-- fill-out form and doesn't need either to render.
CREATE OR REPLACE FUNCTION public.get_submission_share_data(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share forms.submission_shares%ROWTYPE;
  v_form forms.forms%ROWTYPE;
BEGIN
  SELECT * INTO v_share FROM forms.submission_shares WHERE token = p_token AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_share.expires_at IS NOT NULL AND v_share.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  SELECT * INTO v_form FROM forms.forms WHERE id = v_share.form_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'permission', v_share.permission,
    'label', v_share.label,
    'form', jsonb_build_object('id', v_form.id, 'title', v_form.title, 'description', v_form.description),
    'fields', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id, 'form_id', f.form_id, 'field_type', f.field_type, 'label', f.label,
        'options', f.options, 'sort_order', f.sort_order
      ) ORDER BY f.sort_order)
      FROM forms.fields f WHERE f.form_id = v_form.id
    ), '[]'::jsonb),
    'submissions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'form_id', s.form_id, 'respondent_name', s.respondent_name,
        'total_score', s.total_score, 'max_possible_score', s.max_possible_score,
        'submitted_at', s.submitted_at
      ) ORDER BY s.submitted_at DESC)
      FROM forms.submissions s WHERE s.form_id = v_form.id
    ), '[]'::jsonb),
    'responses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'submission_id', r.submission_id, 'field_id', r.field_id,
        'value_text', r.value_text, 'value_array', r.value_array, 'value_option_id', r.value_option_id,
        'file_paths', r.file_paths, 'value_json', r.value_json
      ))
      FROM forms.responses r WHERE r.submission_id IN (SELECT id FROM forms.submissions WHERE form_id = v_form.id)
    ), '[]'::jsonb),
    'submission_columns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'form_id', c.form_id, 'label', c.label, 'column_type', c.column_type,
        'options', c.options, 'sort_order', c.sort_order
      ) ORDER BY c.sort_order)
      FROM forms.submission_columns c WHERE c.form_id = v_form.id
    ), '[]'::jsonb),
    'submission_column_values', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', cv.id, 'submission_id', cv.submission_id, 'column_id', cv.column_id, 'value', cv.value))
      FROM forms.submission_column_values cv WHERE cv.submission_id IN (SELECT id FROM forms.submissions WHERE form_id = v_form.id)
    ), '[]'::jsonb),
    'response_overrides', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'response_id', o.response_id, 'submission_id', o.submission_id, 'field_id', o.field_id,
        'original_value_text', o.original_value_text, 'original_value_array', o.original_value_array, 'original_value_option_id', o.original_value_option_id,
        'override_value_text', o.override_value_text, 'override_value_array', o.override_value_array, 'override_value_option_id', o.override_value_option_id,
        'overridden_at', o.overridden_at, 'override_note', o.override_note
      ))
      FROM forms.response_overrides o WHERE o.submission_id IN (SELECT id FROM forms.submissions WHERE form_id = v_form.id)
    ), '[]'::jsonb)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_submission_share_data(uuid) TO anon, authenticated;

-- Public, no-auth write #1: save/update a response override -- mirrors
-- FormResultsPage.tsx's handleOverrideSave() but server-side, re-checking
-- the token's own permission = 'edit' AND active AND not expired on every
-- call rather than trusting the client to only call this when its own
-- locally-known permission says it can.
CREATE OR REPLACE FUNCTION public.submission_share_save_override(
  p_token uuid,
  p_response_id uuid,
  p_value_text text,
  p_value_array text[],
  p_value_option_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share forms.submission_shares%ROWTYPE;
  v_resp forms.responses%ROWTYPE;
  v_existing_id uuid;
BEGIN
  SELECT * INTO v_share FROM forms.submission_shares WHERE token = p_token AND active AND permission = 'edit';
  IF NOT FOUND OR (v_share.expires_at IS NOT NULL AND v_share.expires_at < now()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT r.* INTO v_resp FROM forms.responses r
    JOIN forms.submissions s ON s.id = r.submission_id
    WHERE r.id = p_response_id AND s.form_id = v_share.form_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id INTO v_existing_id FROM forms.response_overrides WHERE response_id = p_response_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE forms.response_overrides SET
      override_value_text = p_value_text, override_value_array = p_value_array, override_value_option_id = p_value_option_id,
      overridden_by = NULL, overridden_at = now()
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO forms.response_overrides (
      response_id, submission_id, field_id,
      original_value_text, original_value_array, original_value_option_id,
      override_value_text, override_value_array, override_value_option_id,
      overridden_by
    ) VALUES (
      v_resp.id, v_resp.submission_id, v_resp.field_id,
      v_resp.value_text, v_resp.value_array, v_resp.value_option_id,
      p_value_text, p_value_array, p_value_option_id,
      NULL
    );
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submission_share_save_override(uuid, uuid, text, text[], text) TO anon, authenticated;

-- Public, no-auth write #2: revert an override back to the original
-- submitted value (deletes the override row) -- same permission re-check.
CREATE OR REPLACE FUNCTION public.submission_share_revert_override(p_token uuid, p_response_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share forms.submission_shares%ROWTYPE;
BEGIN
  SELECT * INTO v_share FROM forms.submission_shares WHERE token = p_token AND active AND permission = 'edit';
  IF NOT FOUND OR (v_share.expires_at IS NOT NULL AND v_share.expires_at < now()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  DELETE FROM forms.response_overrides o
    USING forms.responses r, forms.submissions s
    WHERE o.response_id = p_response_id AND o.response_id = r.id AND r.submission_id = s.id AND s.form_id = v_share.form_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submission_share_revert_override(uuid, uuid) TO anon, authenticated;

-- Public, no-auth write #3: edit a tracking-column value (the amber
-- "Add Column" cells) -- same permission re-check, upserts by
-- (submission_id, column_id) after confirming both belong to this
-- share's own form.
CREATE OR REPLACE FUNCTION public.submission_share_save_column_value(
  p_token uuid,
  p_submission_id uuid,
  p_column_id uuid,
  p_value text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share forms.submission_shares%ROWTYPE;
  v_existing_id uuid;
BEGIN
  SELECT * INTO v_share FROM forms.submission_shares WHERE token = p_token AND active AND permission = 'edit';
  IF NOT FOUND OR (v_share.expires_at IS NOT NULL AND v_share.expires_at < now()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM forms.submissions WHERE id = p_submission_id AND form_id = v_share.form_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM forms.submission_columns WHERE id = p_column_id AND form_id = v_share.form_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id INTO v_existing_id FROM forms.submission_column_values WHERE submission_id = p_submission_id AND column_id = p_column_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE forms.submission_column_values SET value = p_value, updated_by = NULL, updated_at = now() WHERE id = v_existing_id;
  ELSE
    INSERT INTO forms.submission_column_values (submission_id, column_id, value, updated_by)
    VALUES (p_submission_id, p_column_id, p_value, NULL);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submission_share_save_column_value(uuid, uuid, uuid, text) TO anon, authenticated;
