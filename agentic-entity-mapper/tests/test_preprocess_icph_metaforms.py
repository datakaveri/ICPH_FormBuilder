import unittest

from preprocess_icph_metaforms import extract_schema_rows


class PreprocessIcphMetaformsTest(unittest.TestCase):
    def test_extracts_interview_style_questions_when_no_schema_table_exists(self):
        markdown = """
**Exit Interview**

**A Participant & device identification**

|  |  |
| --- | --- |
| **Participant ID \\***  __________________ | **Date of monitoring \\* (DD/MM/YYYY)**  __________________ |

**B Device wear & compliance**

**B1. Did you wear the strap continuously throughout the 24 hours? \\***

☐ Yes, continuously ☐ No — brief removal(s) ☐ No — off for >1 hour

**B2. If removed, approximately how long was it off, and why?**

____________________________________________________
"""
        rows = extract_schema_rows(markdown, "Exit_Interview_Form_v6_24th_july_2026_.docx", "abc123")

        variables = [row.variable for row in rows]
        self.assertIn("participant_id", variables)
        self.assertIn("date_of_monitoring", variables)
        self.assertIn("B1", variables)
        self.assertIn("B2", variables)
        b1 = next(row for row in rows if row.variable == "B1")
        self.assertEqual(b1.form_title, "Exit Interview")
        self.assertIn("Yes, continuously", b1.format_options)
        self.assertIn("Device wear", b1.instructions)


if __name__ == "__main__":
    unittest.main()
