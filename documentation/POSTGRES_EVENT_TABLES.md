# PostgreSQL event tables

When `ACTIVE_DATABASE=postgresql` (or an admin switches to PostgreSQL at runtime),
`POST /collect` stores SDK events in PostgreSQL with the same login / session /
payment split used for MongoDB.

| Table | Contents | Mongo equivalent |
|---|---|---|
| `login_events` | Events before and at login, and after a logout | `login_events` |
| `session_events` | Logged-in events, up to and including logout | `session_events` |
| `payment_events` | Logged-in events on a payment page (`PAYMENT_PAGE_PATTERN` or `pageType: 'payment'`) | `payment_events` |
| `xylium_sessions` | Per-session phase, user, login/logout times, counters | `sessions` |

All tables are created automatically on connect (`CREATE TABLE IF NOT EXISTS`),
and any missing catalog column is added to an existing table on startup.

## Layout: one row per event, one column per field

There is no JSON in these tables. The three event tables share one schema, so
they can be combined with `UNION ALL`.

How SDK fields become columns:

| SDK value | Column(s) | Example |
|---|---|---|
| scalar field | `snake_case` name | `holdTimeMs` -> `hold_time_ms` |
| nested object | parent and child joined | `params.maxTextureSize` -> `params_max_texture_size` |
| number array of up to 4 items | one numbered column per item | `intervalMs` -> `interval_ms_1`, `interval_ms_2` |
| any other array | one TEXT column joined with `' \| '` | `fonts` -> `'Arial \| Verdana'` |
| custom `track(name, props)` | `event_name` = name, `props_<key>` per prop | `props.amount` -> `props_amount` |

Numbers are `DOUBLE PRECISION`, true/false values are `BOOLEAN`, and everything else is `TEXT`.

## New SDK fields

A field that has no column yet gets a new column in all three tables the first
time it arrives. Its type is inferred from that first value. Settings:
`PG_EVENT_AUTO_COLUMNS` (default `true`) and `PG_EVENT_MAX_COLUMNS` (default `1200`).

After changing or adding an SDK pattern, run:

```
npm run pg:columns              # lists SDK fields that are not in the catalog yet
npm run pg:columns -- --sql     # also prints ALTER TABLE statements
```

Then add the new fields, with the right types, to `SDK_FIELDS` in
`src/database/postgres/sdk-event-columns.js`.

## Reading it for ML

```sql
SELECT 'login' AS phase, * FROM login_events
UNION ALL SELECT 'session', * FROM session_events
UNION ALL SELECT 'payment', * FROM payment_events;
```

```python
import pandas as pd
df = pd.read_sql("SELECT * FROM login_events WHERE event_type = 'typing_summary'", engine)
```

Rows of one event type only fill that type's columns; the other columns are NULL.
To build one feature row per session, filter by `event_type` and pivot or
aggregate per `session_id`.

## Everything else in PostgreSQL

When PostgreSQL is the active database, nothing is stored in MongoDB, and the
server does not connect to Mongo at startup. Every former Mongo collection has
a PostgreSQL table, created automatically on connect:

| Mongo collection | PostgreSQL table | Notes |
|---|---|---|
| `sessions` | `xylium_sessions` | Login phase and user per `/collect` session |
| `event_batches` | `event_batches` | One row per `/collect` batch. The events themselves are in `login_/session_/payment_events`, linked by `batch_id`. |
| `network_intel` | `network_intel` | IP lookup per session + IP (`/ip-intel`) |
| `user_geo_history` | `user_geo_history` | One row per user + country, used for `is_new_country` |
| `behaviour_sessions` | `behaviour_sessions` | Analytics sessions. `deviceMetadata` becomes `device_meta_*` columns and the end-of-session `summary` becomes `final_summary_*` columns. |
| `behaviour_sessions.riskSummary.signals` | `session_risk_signals` | One row per risk signal; `metric` becomes `metric_*` columns |
| `page_engagements` | `page_engagements` | |
| `payment_records` | `payment_records` | Payment `metadata` becomes `metadata_*` columns |

None of these tables uses JSON. Free-form objects are flattened with the same
rules as the event tables, and their columns are added the first time a key appears.
API responses keep the same shape as with MongoDB.

**Retention:** with `RAW_TTL_DAYS` > 0, an hourly job deletes rows older than
that many days from `login_events`, `session_events`, `payment_events` and
`event_batches`. This is the PostgreSQL version of the Mongo TTL index.

**Not converted:** the canonical `events` table, used by `/api/events` and the
risk engine, still has its original `properties` and `device` JSONB columns.

## Column reference

| column | type | SDK field | sent by event types |
|---|---|---|---|
| `id` | BIGSERIAL | (envelope) | Row id |
| `tenant_id` | TEXT | (envelope) | Tenant that sent the batch |
| `app_id` | TEXT | (envelope) | App id from the SDK config |
| `session_id` | TEXT | (envelope) | SDK session id |
| `user_id` | TEXT | (envelope) | Logged-in user (back-filled onto pre-login rows after identify) |
| `device_fingerprint` | TEXT | (envelope) | Device fingerprint sent with the batch |
| `client_ip` | TEXT | (envelope) | Client IP seen by the collector |
| `event_type` | TEXT | (envelope) | SDK event type (evt.type) |
| `event_name` | TEXT | (envelope) | Custom event name for track(); otherwise equals event_type |
| `event_category` | TEXT | (envelope) | pointer / keyboard / form / device / ... (derived from type) |
| `page` | TEXT | (envelope) | location.pathname when the event fired |
| `page_type` | TEXT | (envelope) | SDK pageType (e.g. payment) |
| `sdk_t_ms` | DOUBLE | (envelope) | ms since SDK start on the page (evt.t), not wall-clock |
| `batch_id` | TEXT | (envelope) | Id of the /collect batch this event arrived in |
| `batch_seq` | INTEGER | (envelope) | Position of the event inside its batch |
| `received_at` | TIMESTAMPTZ | (envelope) | Server receive time |
| `abandon_count` | DOUBLE PRECISION | `abandonCount` | form_abandon, form_return |
| `active_field` | TEXT | `activeField` | window_blur |
| `active_is_iframe` | BOOLEAN | `activeIsIframe` | window_blur |
| `actual_path_px` | DOUBLE PRECISION | `actualPathPx` | mouse_trajectory |
| `anomalies` | TEXT (list, ' \| ' separated) | `anomalies` | media_query_snapshot |
| `any_pointer_coarse` | BOOLEAN | `anyPointerCoarse` | media_query_snapshot |
| `approach_angle_deg` | DOUBLE PRECISION | `approachAngleDeg` | overshoot |
| `artifacts` | TEXT (list, ' \| ' separated) | `artifacts` | automation_signals |
| `audio_hash` | TEXT | `audioHash` | audio_fingerprint |
| `avg_angle_change_deg` | DOUBLE PRECISION | `avgAngleChangeDeg` | mouse_entropy |
| `avg_flight_ms` | DOUBLE PRECISION | `avgFlightMs` | typing_summary |
| `avg_hold_ms` | DOUBLE PRECISION | `avgHoldMs` | typing_summary |
| `avg_time_per_focus_ms` | DOUBLE PRECISION | `avgTimePerFocusMs` | field_time_spent |
| `avg_velocity` | DOUBLE PRECISION | `avgVelocity` | swipe |
| `away_ms` | DOUBLE PRECISION | `awayMs` | form_return, tab_switch_return, window_focus |
| `back_count` | DOUBLE PRECISION | `backCount` | back_navigation |
| `before_first_keypress` | BOOLEAN | `beforeFirstKeypress` | first_mouse_move |
| `burst_index` | DOUBLE PRECISION | `burstIndex` | correction_key |
| `canvas_hash` | TEXT | `canvasHash` | canvas_fingerprint |
| `category` | TEXT | `category` | referrer_context |
| `cdp_runtime_detected` | BOOLEAN | `cdpRuntimeDetected` | automation_signals |
| `char_count` | DOUBLE PRECISION | `charCount` | typing_summary |
| `charging` | BOOLEAN | `charging` | battery_snapshot |
| `charging_time` | DOUBLE PRECISION | `chargingTime` | battery_snapshot |
| `chars_added` | DOUBLE PRECISION | `charsAdded` | field_bulk_insert |
| `chars_per_minute` | DOUBLE PRECISION | `charsPerMinute` | typing_summary |
| `clear_count` | DOUBLE PRECISION | `clearCount` | field_cleared |
| `cleared_length` | DOUBLE PRECISION | `clearedLength` | field_cleared |
| `color_gamut` | TEXT | `colorGamut` | media_query_snapshot |
| `color_scheme` | TEXT | `colorScheme` | media_query_snapshot |
| `composite_hash` | TEXT | `compositeHash` | composite_fingerprint |
| `cookie_enabled` | BOOLEAN | `cookieEnabled` | privacy_signals |
| `correction_count` | DOUBLE PRECISION | `correctionCount` | typing_summary |
| `correction_ms` | DOUBLE PRECISION | `correctionMs` | overshoot |
| `correction_rate` | DOUBLE PRECISION | `correctionRate` | typing_summary |
| `cv` | DOUBLE PRECISION | `cv` | rtt_variance |
| `data_length` | DOUBLE PRECISION | `dataLength` | canvas_fingerprint |
| `days_since_first_seen` | DOUBLE PRECISION | `daysSinceFirstSeen` | device_identity |
| `deceleration_samples` | DOUBLE PRECISION | `decelerationSamples` | overshoot |
| `decel_ratio` | DOUBLE PRECISION | `decelRatio` | swipe |
| `delta_hours` | DOUBLE PRECISION | `deltaHours` | tz_geo_consistency |
| `detected_count` | DOUBLE PRECISION | `detectedCount` | font_fingerprint |
| `device_memory` | DOUBLE PRECISION | `deviceMemory` | device_snapshot |
| `device_type` | TEXT | `deviceType` | device_snapshot |
| `did_overshoot` | BOOLEAN | `didOvershoot` | overshoot |
| `direction` | TEXT | `direction` | swipe |
| `discharging_time` | DOUBLE PRECISION | `dischargingTime` | battery_snapshot |
| `distance_px` | DOUBLE PRECISION | `distancePx` | swipe |
| `dns_ms` | DOUBLE PRECISION | `dnsMs` | network_timing |
| `do_not_track` | BOOLEAN | `doNotTrack` | privacy_signals |
| `downlink_mbps` | DOUBLE PRECISION | `downlinkMbps` | connection_change, connection_snapshot |
| `drift_px` | DOUBLE PRECISION | `driftPx` | double_click |
| `duration_ms` | DOUBLE PRECISION | `durationMs` | mouse_trajectory, multi_touch, swipe, touch_tap |
| `effective_type` | TEXT | `effectiveType` | connection_change, connection_snapshot |
| `end_velocity` | DOUBLE PRECISION | `endVelocity` | swipe |
| `entropy` | DOUBLE PRECISION | `entropy` | mouse_entropy |
| `extension_count` | DOUBLE PRECISION | `extensionCount` | webgl_fingerprint |
| `failed` | TEXT | `failed` | audio_fingerprint |
| `failed_attempts_in_window` | DOUBLE PRECISION | `failedAttemptsInWindow` | login_result |
| `field` | TEXT | `field` | autofill, blur, click, copy, correction_key, double_click, field_bulk_insert, field_cleared, field_retyped, field_time_spent, first_field_interaction, focus, hover_before_click, keyboard_shortcut, keydown, keytiming, keytiming_ngram, keyup, mouse_trajectory, mousedown, mouseup, password_visibility_toggle, paste, rightclick, shift_pattern, single_click_confirmed, touch_pressure, touch_tap, typing_summary |
| `field_kind` | TEXT | `fieldKind` | field_bulk_insert, first_field_interaction, typing_summary |
| `fields_touched` | DOUBLE PRECISION | `fieldsTouched` | form_abandon |
| `fill_time_ms` | DOUBLE PRECISION | `fillTimeMs` | autofill |
| `final_speed_px_per_ms` | DOUBLE PRECISION | `finalSpeedPxPerMs` | overshoot |
| `first_dx` | DOUBLE PRECISION | `firstDx` | first_mouse_move |
| `first_dy` | DOUBLE PRECISION | `firstDy` | first_mouse_move |
| `first_seen_at` | DOUBLE PRECISION | `firstSeenAt` | device_identity |
| `first_speed_px` | DOUBLE PRECISION | `firstSpeedPx` | first_mouse_move |
| `flight_time_ms` | DOUBLE PRECISION | `flightTimeMs` | keytiming |
| `focus_count` | DOUBLE PRECISION | `focusCount` | field_time_spent |
| `fonts` | TEXT (list, ' \| ' separated) | `fonts` | font_fingerprint |
| `fonts_hash` | TEXT | `fontsHash` | font_fingerprint |
| `force` | DOUBLE PRECISION | `force` | touch_pressure |
| `forced_colors` | BOOLEAN | `forcedColors` | media_query_snapshot |
| `from_cache` | BOOLEAN | `fromCache` | network_timing |
| `gap_from_last_ms` | DOUBLE PRECISION | `gapFromLastMs` | correction_key |
| `gap_ms` | DOUBLE PRECISION | `gapMs` | double_click |
| `geo_accuracy_m` | DOUBLE PRECISION | `geo_accuracy_m` | geo_features |
| `geo_distance_from_home_km` | DOUBLE PRECISION | `geo_distance_from_home_km` | geo_features |
| `geo_home_source` | TEXT | `geo_home_source` | geo_features |
| `geo_is_new_country` | BOOLEAN | `geo_is_new_country` | network_risk |
| `geo_is_new_country_source` | TEXT | `geo_is_new_country_source` | network_risk |
| `geo_lat` | DOUBLE PRECISION | `geo_lat` | geo_features |
| `geo_lon` | DOUBLE PRECISION | `geo_lon` | geo_features |
| `gesture` | TEXT | `gesture` | multi_touch |
| `global_privacy_control` | BOOLEAN | `globalPrivacyControl` | privacy_signals |
| `h` | DOUBLE PRECISION | `h` | resize |
| `had_interaction` | BOOLEAN | `hadInteraction` | form_submit |
| `hardware_concurrency` | DOUBLE PRECISION | `hardwareConcurrency` | device_snapshot |
| `has_pdf_viewer` | BOOLEAN | `hasPdfViewer` | plugin_snapshot |
| `has_value` | BOOLEAN | `hasValue` | password_visibility_toggle |
| `hdr` | BOOLEAN | `hdr` | media_query_snapshot |
| `headless_signals` | TEXT (list, ' \| ' separated) | `headlessSignals` | automation_signals |
| `hidden_ms` | DOUBLE PRECISION | `hiddenMs` | visibility_away |
| `history_length` | DOUBLE PRECISION | `historyLength` | referrer_context |
| `hold_time_ms` | DOUBLE PRECISION | `holdTimeMs` | correction_key, keytiming |
| `hover` | BOOLEAN | `hover` | media_query_snapshot |
| `hover_duration_ms` | DOUBLE PRECISION | `hoverDurationMs` | hover_before_click |
| `idle_duration_ms` | DOUBLE PRECISION | `idleDurationMs` | idle_end |
| `indicator_count` | DOUBLE PRECISION | `indicatorCount` | automation_signals |
| `input_type` | TEXT | `inputType` | field_bulk_insert, field_retyped |
| `integer_timestamp_ratio` | DOUBLE PRECISION | `integerTimestampRatio` | event_integrity |
| `interval_ms_1` | DOUBLE PRECISION | `intervalMs.1` | keytiming_ngram |
| `interval_ms_2` | DOUBLE PRECISION | `intervalMs.2` | keytiming_ngram |
| `intl_locale` | TEXT | `intlLocale` | language_snapshot |
| `intl_matches_primary` | BOOLEAN | `intlMatchesPrimary` | language_snapshot |
| `ip_country` | TEXT | `ip_country` | network_risk |
| `ip_tz_mismatch` | BOOLEAN | `ip_tz_mismatch` | network_risk |
| `is_datacenter` | BOOLEAN | `is_datacenter` | network_risk |
| `is_proxy` | BOOLEAN | `is_proxy` | network_risk |
| `is_vpn` | BOOLEAN | `is_vpn` | network_risk |
| `is_back_forward` | BOOLEAN | `isBackForward` | page_entry_method |
| `is_held` | BOOLEAN | `isHeld` | correction_key |
| `is_http2` | BOOLEAN | `isHttp2` | network_timing |
| `is_http3` | BOOLEAN | `isHttp3` | network_timing |
| `is_linear` | BOOLEAN | `isLinear` | field_focus_order |
| `is_mismatch` | BOOLEAN | `isMismatch` | tz_geo_consistency |
| `is_new_device` | BOOLEAN | `isNewDevice` | device_identity |
| `is_panic_back` | BOOLEAN | `isPanicBack` | back_navigation |
| `is_password_field` | BOOLEAN | `isPasswordField` | paste |
| `is_randomized` | BOOLEAN | `isRandomized` | canvas_fingerprint |
| `is_software_renderer` | BOOLEAN | `isSoftwareRenderer` | webgl_fingerprint |
| `is_suspicious` | BOOLEAN | `isSuspicious` | referrer_context |
| `is_trusted` | BOOLEAN | `isTrusted` | field_bulk_insert, field_cleared, first_field_interaction, paste, swipe, touch_pressure, touch_tap |
| `is_weekend` | BOOLEAN | `isWeekend` | time_context |
| `is_zero_hover` | BOOLEAN | `isZeroHover` | hover_before_click |
| `jitter_ms` | DOUBLE PRECISION | `jitterMs` | rtt_variance |
| `jitter_px` | DOUBLE PRECISION | `jitterPx` | touch_tap |
| `jitter_sample_count` | DOUBLE PRECISION | `jitterSampleCount` | touch_tap |
| `jump_count` | DOUBLE PRECISION | `jumpCount` | field_focus_order |
| `key` | TEXT | `key` | correction_key, keydown, keyup |
| `key_count` | DOUBLE PRECISION | `keyCount` | typing_summary |
| `key_interval_count` | DOUBLE PRECISION | `keyIntervalCount` | event_integrity |
| `key_interval_cv` | DOUBLE PRECISION | `keyIntervalCv` | event_integrity |
| `language_count` | DOUBLE PRECISION | `languageCount` | language_snapshot |
| `languages` | TEXT (list, ' \| ' separated) | `languages` | language_snapshot |
| `last_field` | TEXT | `lastField` | form_abandon |
| `lat` | DOUBLE PRECISION | `lat` | geo |
| `level` | DOUBLE PRECISION | `level` | battery_snapshot |
| `local_day_name` | TEXT | `localDayName` | time_context |
| `local_day_of_week` | DOUBLE PRECISION | `localDayOfWeek` | time_context |
| `local_hour` | DOUBLE PRECISION | `localHour` | time_context |
| `local_minute` | DOUBLE PRECISION | `localMinute` | time_context |
| `lon` | DOUBLE PRECISION | `lon` | geo |
| `max_deviation_px` | DOUBLE PRECISION | `maxDeviationPx` | mouse_trajectory |
| `max_ms` | DOUBLE PRECISION | `maxMs` | rtt_variance |
| `max_touches` | DOUBLE PRECISION | `maxTouches` | multi_touch |
| `max_touch_points` | DOUBLE PRECISION | `maxTouchPoints` | media_query_snapshot |
| `mean_ms` | DOUBLE PRECISION | `meanMs` | rtt_variance |
| `median_flight_ms` | DOUBLE PRECISION | `medianFlightMs` | typing_summary |
| `method` | TEXT | `method` | autofill, field_cleared, shift_pattern |
| `mid_login` | BOOLEAN | `midLogin` | visibility_away, window_blur, window_focus |
| `mid_login_switch_count` | DOUBLE PRECISION | `midLoginSwitchCount` | window_blur |
| `mime_type_count` | DOUBLE PRECISION | `mimeTypeCount` | plugin_snapshot |
| `mime_types` | TEXT (list, ' \| ' separated) | `mimeTypes` | plugin_snapshot |
| `min_ms` | DOUBLE PRECISION | `minMs` | rtt_variance |
| `mouse_moved_first` | BOOLEAN | `mouseMovedFirst` | first_field_interaction |
| `ms_since_clear` | DOUBLE PRECISION | `msSinceClear` | field_retyped |
| `ms_since_last_seen` | DOUBLE PRECISION | `msSinceLastSeen` | device_identity |
| `n` | DOUBLE PRECISION | `n` | keytiming_ngram |
| `nav_type` | TEXT | `navType` | page_entry_method |
| `network_risk_source` | TEXT | `network_risk_source` | network_risk |
| `offset_norm` | DOUBLE PRECISION | `offsetNorm` | touch_tap |
| `offset_x_px` | DOUBLE PRECISION | `offsetXPx` | touch_tap |
| `offset_y_px` | DOUBLE PRECISION | `offsetYPx` | touch_tap |
| `os_family` | TEXT | `osFamily` | device_snapshot |
| `overshoot_px` | DOUBLE PRECISION | `overshootPx` | overshoot |
| `params_max_texture_size` | DOUBLE PRECISION | `params.maxTextureSize` | webgl_fingerprint |
| `params_max_renderbuffer_size` | DOUBLE PRECISION | `params.maxRenderbufferSize` | webgl_fingerprint |
| `params_max_viewport_dims_1` | DOUBLE PRECISION | `params.maxViewportDims.1` | webgl_fingerprint |
| `params_max_viewport_dims_2` | DOUBLE PRECISION | `params.maxViewportDims.2` | webgl_fingerprint |
| `params_max_vertex_attribs` | DOUBLE PRECISION | `params.maxVertexAttribs` | webgl_fingerprint |
| `params_aliased_line_width_range_1` | DOUBLE PRECISION | `params.aliasedLineWidthRange.1` | webgl_fingerprint |
| `params_aliased_line_width_range_2` | DOUBLE PRECISION | `params.aliasedLineWidthRange.2` | webgl_fingerprint |
| `params_shading_language_version` | TEXT | `params.shadingLanguageVersion` | webgl_fingerprint |
| `params_hash` | TEXT | `paramsHash` | webgl_fingerprint |
| `parts_canvas` | TEXT | `parts.canvas` | composite_fingerprint |
| `parts_webgl` | TEXT | `parts.webgl` | composite_fingerprint |
| `parts_fonts` | TEXT | `parts.fonts` | composite_fingerprint |
| `parts_audio` | TEXT | `parts.audio` | composite_fingerprint |
| `password_autofill_method` | TEXT | `password_autofill_method` | autofill_summary |
| `password_autofilled` | BOOLEAN | `password_autofilled` | autofill_summary |
| `password_fill_time_ms` | DOUBLE PRECISION | `password_fill_time_ms` | autofill_summary |
| `pasted_from_keyboard` | BOOLEAN | `pastedFromKeyboard` | paste |
| `pasted_has_whitespace` | BOOLEAN | `pastedHasWhitespace` | paste |
| `pasted_length` | DOUBLE PRECISION | `pastedLength` | paste |
| `pasted_non_printable` | BOOLEAN | `pastedNonPrintable` | paste |
| `peak_velocity` | DOUBLE PRECISION | `peakVelocity` | swipe |
| `persistent_device_id` | TEXT | `persistentDeviceId` | device_identity |
| `phase` | TEXT | `phase` | mouse_trajectory |
| `pinch_scale` | DOUBLE PRECISION | `pinchScale` | multi_touch |
| `plugin_count` | DOUBLE PRECISION | `pluginCount` | plugin_snapshot |
| `plugin_names` | TEXT (list, ' \| ' separated) | `pluginNames` | plugin_snapshot |
| `plugins_hash` | TEXT | `pluginsHash` | plugin_snapshot |
| `pointer` | TEXT | `pointer` | media_query_snapshot |
| `precise` | BOOLEAN | `precise` | rtt_variance |
| `primary_language` | TEXT | `primaryLanguage` | language_snapshot |
| `primary_matches_list` | BOOLEAN | `primaryMatchesList` | language_snapshot |
| `probed_count` | DOUBLE PRECISION | `probedCount` | font_fingerprint |
| `protocol` | TEXT | `protocol` | network_timing |
| `radius_x` | DOUBLE PRECISION | `radiusX` | touch_pressure, touch_tap |
| `radius_y` | DOUBLE PRECISION | `radiusY` | touch_pressure, touch_tap |
| `reason` | TEXT | `reason` | login_result |
| `redirect_count` | DOUBLE PRECISION | `redirectCount` | network_timing, referrer_context |
| `reduced_motion` | BOOLEAN | `reducedMotion` | media_query_snapshot |
| `referrer_host` | TEXT | `referrerHost` | referrer_context |
| `renderer` | TEXT | `renderer` | webgl_fingerprint |
| `returned_after_back` | BOOLEAN | `returnedAfterBack` | back_navigation |
| `returned_to_field` | TEXT | `returnedToField` | window_focus |
| `retype_count` | DOUBLE PRECISION | `retypeCount` | field_retyped |
| `round_interval_ratio` | DOUBLE PRECISION | `roundIntervalRatio` | event_integrity |
| `rtt_ms` | DOUBLE PRECISION | `rttMs` | connection_change, connection_snapshot |
| `same_origin` | BOOLEAN | `sameOrigin` | referrer_context |
| `same_session` | BOOLEAN | `sameSession` | form_return |
| `sample_count` | DOUBLE PRECISION | `sampleCount` | mouse_entropy, mouse_trajectory, rtt_variance, swipe |
| `sample_sum` | DOUBLE PRECISION | `sampleSum` | audio_fingerprint |
| `save_data` | BOOLEAN | `saveData` | connection_change, connection_snapshot |
| `screen_height` | DOUBLE PRECISION | `screenHeight` | device_snapshot |
| `screen_width` | DOUBLE PRECISION | `screenWidth` | device_snapshot |
| `sequence` | TEXT (list, ' \| ' separated) | `sequence` | field_focus_order |
| `shift_hold_ms` | DOUBLE PRECISION | `shiftHoldMs` | shift_pattern |
| `shortcut` | TEXT | `shortcut` | keyboard_shortcut |
| `signal` | TEXT | `signal` | automation_signal |
| `solar_offset_hours` | DOUBLE PRECISION | `solarOffsetHours` | tz_geo_consistency |
| `source` | TEXT | `source` | form_submit |
| `state` | TEXT | `state` | visibilitychange |
| `std_angle_change_deg` | DOUBLE PRECISION | `stdAngleChangeDeg` | mouse_entropy |
| `std_flight_ms` | DOUBLE PRECISION | `stdFlightMs` | typing_summary |
| `std_hold_ms` | DOUBLE PRECISION | `stdHoldMs` | typing_summary |
| `std_ms` | DOUBLE PRECISION | `stdMs` | rtt_variance |
| `storage_available` | BOOLEAN | `storageAvailable` | device_identity |
| `straight_line_px` | DOUBLE PRECISION | `straightLinePx` | mouse_trajectory |
| `straightness_index` | DOUBLE PRECISION | `straightnessIndex` | mouse_trajectory |
| `success` | BOOLEAN | `success` | login_result |
| `supported` | BOOLEAN | `supported` | audio_fingerprint, canvas_fingerprint, font_fingerprint, webgl_fingerprint |
| `suspicious_reasons` | TEXT (list, ' \| ' separated) | `suspiciousReasons` | referrer_context |
| `switch_count` | DOUBLE PRECISION | `switchCount` | tab_switch_return |
| `tag` | TEXT | `tag` | hover_before_click, touch_tap |
| `tcp_connect_ms` | DOUBLE PRECISION | `tcpConnectMs` | network_timing |
| `time_from_init_ms` | DOUBLE PRECISION | `timeFromInitMs` | first_field_interaction, first_mouse_move |
| `time_from_load_ms` | DOUBLE PRECISION | `timeFromLoadMs` | first_field_interaction, first_mouse_move, form_submit, password_visibility_toggle |
| `time_on_page_ms` | DOUBLE PRECISION | `timeOnPageMs` | back_navigation, form_abandon |
| `time_slot` | TEXT | `timeSlot` | time_context |
| `tls_ms` | DOUBLE PRECISION | `tlsMs` | network_timing |
| `toggle_count` | DOUBLE PRECISION | `toggleCount` | password_visibility_toggle |
| `total_events` | DOUBLE PRECISION | `totalEvents` | event_integrity |
| `total_fields` | DOUBLE PRECISION | `totalFields` | field_focus_order |
| `total_time_ms` | DOUBLE PRECISION | `totalTimeMs` | field_time_spent |
| `trigger` | TEXT | `trigger` | autofill_summary |
| `ttfb_ms` | DOUBLE PRECISION | `ttfbMs` | network_timing |
| `tz_name` | TEXT | `tzName` | time_context, tz_geo_consistency |
| `tz_offset_hours` | DOUBLE PRECISION | `tzOffsetHours` | tz_geo_consistency |
| `tz_offset_minutes` | DOUBLE PRECISION | `tzOffsetMinutes` | time_context |
| `unavailable_or_unstable` | TEXT (list, ' \| ' separated) | `unavailableOrUnstable` | composite_fingerprint |
| `unmasked_renderer` | TEXT | `unmaskedRenderer` | webgl_fingerprint |
| `unmasked_vendor` | TEXT | `unmaskedVendor` | webgl_fingerprint |
| `untrusted_events` | DOUBLE PRECISION | `untrustedEvents` | event_integrity |
| `untrusted_ratio` | DOUBLE PRECISION | `untrustedRatio` | event_integrity |
| `username_autofill_method` | TEXT | `username_autofill_method` | autofill_summary |
| `username_autofilled` | BOOLEAN | `username_autofilled` | autofill_summary |
| `username_fill_time_ms` | DOUBLE PRECISION | `username_fill_time_ms` | autofill_summary |
| `utc_hour` | DOUBLE PRECISION | `utcHour` | time_context |
| `utm_medium` | TEXT | `utmMedium` | referrer_context |
| `utm_source` | TEXT | `utmSource` | referrer_context |
| `vendor` | TEXT | `vendor` | webgl_fingerprint |
| `via` | TEXT | `via` | first_field_interaction |
| `viewport_height` | DOUBLE PRECISION | `viewportHeight` | device_snapshot |
| `viewport_width` | DOUBLE PRECISION | `viewportWidth` | device_snapshot |
| `visible` | BOOLEAN | `visible` | password_visibility_toggle |
| `visit_count` | DOUBLE PRECISION | `visitCount` | device_identity |
| `w` | DOUBLE PRECISION | `w` | resize |
| `webdriver` | BOOLEAN | `webdriver` | automation_signals |
| `window_ms` | DOUBLE PRECISION | `windowMs` | login_result |
| `x` | DOUBLE PRECISION | `x` | click, mousedown, mousemove, mouseup, rightclick |
| `y` | DOUBLE PRECISION | `y` | click, mousedown, mousemove, mouseup, rightclick, scroll |
