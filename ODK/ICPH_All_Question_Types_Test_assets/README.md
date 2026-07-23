# ICPH All Question Types Test Assets

Use these files with `../ICPH_All_Question_Types_Test_v2023.1.xlsx`.

When the XLSForm is imported into the ICPH form builder, the Build screen should highlight questions that reference these files. Upload the files from this folder when prompted.

Expected referenced files:

- `external_choices.csv`
- `lookup.csv`
- `prompt_image.svg`
- `prompt_audio.wav`
- `prompt_video.mp4`
- `choice_yes.svg`
- `choice_no.svg`
- `choice_audio.wav`
- `choice_map.geojson`

`choice_map.geojson` is used by the `q_geojson_map_select` question:

- survey type: `select_one_from_file choice_map.geojson`
- appearance: `map`
- parameters: `value=id,label=title`

This tests the ODK GeoJSON external dataset flow. Map-aware renderers should show the point and polygon features as selectable map choices. Browser support depends on the ODK Web Forms renderer.

`sample_file_attachment.txt` is included as a simple respondent-file test upload if you want to try the `file` question while filling the form.

`prompt_big_image.svg` and `choice_big.svg` are included for manual `big-image` testing, but the primary smoke form does not reference them. Current browser rendering can expose `jr://images/...` paths inline for `big-image`, which makes the general test form look broken even though the XLSForm converts.
