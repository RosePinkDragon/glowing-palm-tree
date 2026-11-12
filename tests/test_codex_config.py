"""Regression tests for the checkout validator's supported structural subset."""

import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('validate_codex', ROOT / 'scripts/validate_codex.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ('.codex', '.agents', '.github', 'docs'):
            shutil.copytree(ROOT / directory, self.root / directory)
        shutil.copy2(ROOT / 'AGENTS.md', self.root / 'AGENTS.md')

    def write(self, relative, value):
        (self.root / relative).write_text(value, encoding='utf-8')

    def test_valid_and_repeated_validation_are_independent(self):
        self.assertEqual(validator.validate(self.root), [])
        self.write('.codex/config.toml', '[agents\n')
        self.assertTrue(validator.validate(self.root))
        shutil.copy2(ROOT / '.codex/config.toml', self.root / '.codex/config.toml')
        self.assertEqual(validator.validate(self.root), [])

    def test_config_rejects_typos_and_fixed_models(self):
        base = (self.root / '.codex/config.toml').read_text()
        for addition in ('model = "x"\n', 'model_reasoning_effort = "high"\n', 'enabld = true\n'):
            with self.subTest(addition=addition):
                self.write('.codex/config.toml', base + addition)
                self.assertTrue(validator.validate(self.root))
        self.write('.codex/config.toml', 'model = "x"\n' + base)
        self.assertTrue(validator.validate(self.root))

    def test_role_missing_malformed_misnamed_and_fixed_model(self):
        path = '.codex/agents/ba.toml'
        original = (self.root / path).read_text()
        for bad in ('name = "ba"\n', 'name = [\n', original.replace('name = "ba"', 'name = "wrong"'), original + '\nmodel = "x"\n', original + '\nmodel_reasoning_effort = "high"\n'):
            with self.subTest(bad=bad[:30]):
                self.write(path, bad)
                self.assertTrue(validator.validate(self.root))
        (self.root / path).unlink()
        self.assertTrue(validator.validate(self.root))

    def test_skill_front_matter_and_body(self):
        path = '.agents/skills/team-lead/SKILL.md'
        good = '---\nname: team-lead\ndescription: "Useful: skill"\n---\n# Body\n'
        self.write(path, good)
        self.assertEqual(validator.validate(self.root), [])
        for bad in (good.replace('"Useful: skill"', ''), good.replace('team-lead', 'wrong'), good.replace('\n---\n# Body', '\n# Body'), good.replace('# Body', '  '), good.replace('description:', 'descripton:'), good.replace('"Useful: skill"', '123'), good.replace('"Useful: skill"', '# comment'), good.replace('description: "Useful: skill"', 'description: "Useful: skill"\ndescription: again')):
            with self.subTest(bad=bad):
                self.write(path, bad)
                self.assertTrue(validator.validate(self.root))


if __name__ == '__main__':
    unittest.main()
