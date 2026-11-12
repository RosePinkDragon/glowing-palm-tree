import copy
import unittest
from unittest.mock import patch

from evaluator import BRANCH, evaluate, linked_issue
import runner


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.pr = {'head': {'ref': 'feature/monorepo-3-delivery-guardrails'}, 'body': 'Issue: #3'}
        self.issue = {'number': 3, 'state': 'open', 'labels': [{'name': 'enhancement'}, {'name': 'approved'}], 'body': ''}
        self.files = [{'filename': 'src/code.py'}]

    def errors(self):
        return evaluate(self.pr, self.issue, self.files, 'owner/repo')[0]

    def test_valid_and_feature_approval_independent_of_prefix(self):
        self.assertFalse(self.errors())
        self.pr['head']['ref'] = 'bug/monorepo-3-fix'
        self.issue['labels'] = [{'name': 'enhancement'}, {'name': 'bug'}]
        self.assertTrue(any('Feature' in e for e in self.errors()))
        self.pr['head']['ref'] = 'release/monorepo-3-ship'
        self.assertTrue(self.errors())

    def test_branches(self):
        for branch in ['feature/ammu-sammu-customer-2-add-cart', 'bug/konkan-fine-dine-admin-15-fix', 'release/monorepo-1-ship']:
            self.assertIsNotNone(BRANCH.fullmatch(branch))
        for branch in ['Feature/monorepo-3-x', 'feature/monorepo-03-x', 'feature/other-3-x', 'feature/monorepo-3-X', 'feature/monorepo-3-x--y', 'feature/monorepo-0-x']:
            self.assertIsNone(BRANCH.fullmatch(branch), branch)

    def test_link_and_issue(self):
        self.assertEqual(linked_issue('Issue: https://github.com/owner/repo/issues/3', 'owner/repo'), 3)
        for body in ['fixes #3', 'Issue: #3\nIssue: #4', 'Issue: https://github.com/other/repo/issues/3', 'Issue: #03', 'Issue:\n#3', 'Issue: #3\nIssue:', 'Issue: #3\nIssue: garbage']:
            self.assertIsNone(linked_issue(body, 'owner/repo'))
        self.issue['state'] = 'closed'
        self.assertTrue(self.errors())
        self.issue['state'] = 'open'
        self.issue['pull_request'] = {}
        self.assertTrue(self.errors())
        self.issue.pop('pull_request')
        self.pr['head']['ref'] = 'feature/monorepo-4-fix'
        self.assertTrue(self.errors())

    def test_unapproved_bug_evidence_and_unknown(self):
        self.pr['head']['ref'] = 'bug/monorepo-3-fix'
        self.issue['labels'] = [{'name': 'bug'}]
        self.issue['body'] = '## Assessment\nsmall\n## Small blast radius\n<!-- explain -->\n'
        self.assertTrue(self.errors())
        self.issue['body'] = '## Assessment\nsmall\n## Small blast radius\nOnly the admin report is affected.\n'
        self.assertFalse(self.errors())
        self.pr['head']['ref'] = 'feature/monorepo-3-fix'
        self.assertTrue(self.errors())
        self.pr['head']['ref'] = 'bug/monorepo-3-fix'
        self.issue['body'] = '## Assessment\nunderstood\n## Reproduction\nOpen the admin report.\n## Impacts\nAdmins cannot export.\n'
        self.assertFalse(self.errors())
        self.issue['body'] = '## Assessment\nunderstood\n## Reproduction\nOpen the admin report.\n## Impacts\nunknown\n'
        self.assertTrue(self.errors())
        self.issue['labels'] = []
        self.assertTrue(self.errors())
        self.issue['labels'] = [{'name': 'approved'}]
        self.assertFalse(self.errors())

    def test_file_limit_exclusions_and_renames(self):
        self.files = [{'filename': f'code/{n}.py'} for n in range(15)]
        self.files += [{'filename': 'sub/README.md'}, {'filename': 'yarn.lock'}]
        self.assertFalse(self.errors())
        self.files += [{'filename': 'README.md', 'previous_filename': 'code/removed.py'}]
        self.assertTrue(self.errors())
        self.files = [{'filename': 'generated/output.js'} for _ in range(16)]
        self.assertTrue(self.errors())

    def test_negative_bug_assessments(self):
        self.pr['head']['ref'] = 'bug/monorepo-3-fix'
        self.issue['labels'] = [{'name': 'bug'}]
        for value in ['No', '- [ ]', 'unknown']:
            self.issue['body'] = '## Assessment\nsmall\n## Small blast radius\n' + value
            self.assertTrue(self.errors(), value)
        self.issue['body'] = '## Assessment\nunderstood\n## Reproduction\nNot yet investigated.\n## Impacts\nNot understood.'
        self.assertTrue(self.errors())
        self.issue['body'] = ('## Assessment\nunderstood\n## Reproduction\n'
                              'Open the admin report with an unknown customer ID.\n'
                              '## Impacts\nExport is not available to admin users.')
        self.assertFalse(self.errors())

    def runner_pr(self, number=7, sha='head'):
        return {'number': number, 'state': 'open', 'head': {'sha': sha, 'ref': 'feature/monorepo-3-fix', 'repo': {'id': 1}},
                'base': {'sha': 'base', 'ref': 'main', 'repo': {'id': 1}}, 'body': 'Issue: #3', 'draft': False, 'changed_files': 1}

    def test_happy_check_lifecycle_and_volatile_metadata(self):
        pr = self.runner_pr()
        current = copy.deepcopy(pr)
        current['base']['repo']['updated_at'] = 'later'
        with patch.object(runner, 'EVENT', {'repository': {'default_branch': 'main'}}), \
             patch.object(runner, 'REPO', 'owner/repo'), \
             patch.object(runner, 'get_pr', side_effect=[pr, current]), \
             patch.object(runner.subprocess, 'check_output', return_value='base\n'), \
             patch.object(runner, 'pages', return_value=self.files), \
             patch.object(runner, 'request', side_effect=[({'id': 42}, ''), (self.issue, ''), (self.issue, ''), ({}, '')]) as api:
            check = runner.start_check(pr)
            runner.process(pr, check, False)
            self.assertEqual(api.call_args_list[0].args[1]['status'], 'in_progress')
            self.assertEqual(api.call_args_list[-1].args[0], '/repos/owner/repo/check-runs/42')
            self.assertEqual(api.call_args_list[-1].kwargs['method'], 'PATCH')
            self.assertEqual(api.call_args_list[-1].args[1]['conclusion'], 'success')

    def test_failures_after_check_started(self):
        pr = self.runner_pr()
        for failure in ['get', 'evaluate', 'final_get', 'incomplete']:
            reads = [pr, pr]
            if failure == 'get': reads = [RuntimeError('fetch failed')]
            if failure == 'final_get': reads = [pr, RuntimeError('fetch failed')]
            files = [] if failure == 'incomplete' else self.files
            with self.subTest(failure=failure), patch.object(runner, 'EVENT', {'repository': {'default_branch': 'main'}}), \
                 patch.object(runner, 'get_pr', side_effect=reads), \
                 patch.object(runner.subprocess, 'check_output', return_value='base\n'), \
                 patch.object(runner, 'pages', return_value=files), \
                 patch.object(runner, 'request') as api, \
                 patch.object(runner, 'evaluate', side_effect=RuntimeError('bad evaluator') if failure == 'evaluate' else None, wraps=evaluate):
                def response(path, data=None, method=None):
                    if path.endswith('/check-runs'): return ({'id': 42}, '')
                    if path.endswith('/issues/3'): return (self.issue, '')
                    return ({}, '')
                api.side_effect = response
                check = runner.start_check(pr)
                runner.process(pr, check, False)
                self.assertEqual(api.call_args_list[0].args[1]['status'], 'in_progress')
                self.assertTrue(api.call_args.args[0].endswith('/check-runs/42'))
                self.assertEqual(api.call_args.kwargs['method'], 'PATCH')
                self.assertEqual(api.call_args.args[1]['conclusion'], 'failure')

    def test_event_check_started_before_listing_failure(self):
        pr = self.runner_pr()
        with patch.object(runner, 'EVENT', {'pull_request': pr}), \
             patch.object(runner, 'start_check', return_value=42), \
             patch.object(runner, 'pages', side_effect=RuntimeError('outage')), \
             patch.object(runner, 'finish_check') as finish:
            with self.assertRaises(RuntimeError): runner.run_batch()
            self.assertEqual(finish.call_args.args[0], 42)
            self.assertIn('Could not list', finish.call_args.args[1][0])

    def test_same_head_rejected_and_batch_continues(self):
        a, b, c = self.runner_pr(1, 'shared'), self.runner_pr(2, 'shared'), self.runner_pr(3, 'unique')
        seen = []
        def processing(pr, check, shared):
            seen.append((pr['number'], shared))
            if pr['number'] == 1: raise RuntimeError('failed')
        with patch.object(runner, 'EVENT', {}), patch.object(runner, 'pages', return_value=[a, b, c]), \
             patch.object(runner, 'start_check', side_effect=[1, 2, 3]), patch.object(runner, 'process', side_effect=processing):
            with self.assertRaises(RuntimeError): runner.run_batch()
        self.assertEqual(seen, [(1, True), (2, True), (3, False)])
        with patch.object(runner, 'get_pr', return_value=a), patch.object(runner, 'finish_check') as finish:
            runner.process(a, 1, True)
            self.assertIn('share this head', finish.call_args.args[1][0])

    def test_same_head_body_drift_fails(self):
        pr = self.runner_pr()
        changed = copy.deepcopy(pr)
        changed['body'] = 'Issue: #4'
        with patch.object(runner, 'EVENT', {'repository': {'default_branch': 'main'}}), \
             patch.object(runner, 'get_pr', side_effect=[pr, changed]), \
             patch.object(runner.subprocess, 'check_output', return_value='base\n'), \
             patch.object(runner, 'pages', return_value=self.files), \
             patch.object(runner, 'request', return_value=(self.issue, '')), \
             patch.object(runner, 'finish_check') as finish:
            runner.process(pr, 42, False)
            self.assertIn('metadata changed', finish.call_args.args[1][0])

    def test_pages_follow_next_and_cap(self):
        with patch.object(runner, 'request', side_effect=[([1] * 100, '<https://api.github.com/page2>; rel="next"'), ([2], '')]):
            self.assertEqual(len(runner.pages('/path')), 101)
        with patch.object(runner, 'request', return_value=([1], '<https://api.github.com/more>; rel="next"')):
            with self.assertRaises(RuntimeError):
                runner.pages('/path')


if __name__ == '__main__':
    unittest.main()
