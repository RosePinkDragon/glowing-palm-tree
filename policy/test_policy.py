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
        for body in ['fixes #3', 'Issue: #3\nIssue: #4', 'Issue: https://github.com/other/repo/issues/3', 'Issue: #03']:
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
        self.issue['body'] = '## Small blast radius\n<!-- explain -->\n'
        self.assertTrue(self.errors())
        self.issue['body'] = '## Small blast radius\nOnly the admin report is affected.\n'
        self.assertFalse(self.errors())
        self.pr['head']['ref'] = 'feature/monorepo-3-fix'
        self.assertTrue(self.errors())
        self.pr['head']['ref'] = 'bug/monorepo-3-fix'
        self.issue['body'] = '## Reproduction\nOpen report.\n## Impacts\nAdmins cannot export.\n'
        self.assertFalse(self.errors())
        self.issue['body'] = '## Reproduction\nOpen report.\n## Impacts\nunknown\n'
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

    def test_incomplete_file_listing_fails_closed(self):
        pr = {'number': 7, 'state': 'open', 'head': {'sha': 'head', 'ref': 'feature/monorepo-3-fix'},
              'base': {'sha': 'base', 'ref': 'main'}, 'body': 'Issue: #3', 'changed_files': 101}
        with patch.object(runner, 'EVENT', {'repository': {'default_branch': 'main'}}), \
             patch.object(runner, 'get_pr', return_value=pr), \
             patch.object(runner.subprocess, 'check_output', return_value='base\n'), \
             patch.object(runner, 'pages', return_value=[{'filename': 'x'}] * 100), \
             patch.object(runner, 'publish') as publish:
            runner.process(7)
            self.assertIn('incomplete', publish.call_args.args[1][0])

    def test_changed_issue_fails_closed(self):
        pr = {'number': 7, 'state': 'open', 'head': {'sha': 'head', 'ref': 'feature/monorepo-3-fix'},
              'base': {'sha': 'base', 'ref': 'main'}, 'body': 'Issue: #3', 'changed_files': 1}
        changed = copy.deepcopy(self.issue)
        changed['labels'] = [{'name': 'enhancement'}]
        with patch.object(runner, 'EVENT', {'repository': {'default_branch': 'main'}}), \
             patch.object(runner, 'get_pr', return_value=pr), \
             patch.object(runner.subprocess, 'check_output', return_value='base\n'), \
             patch.object(runner, 'pages', return_value=self.files), \
             patch.object(runner, 'request', side_effect=[(self.issue, ''), (changed, '')]), \
             patch.object(runner, 'publish') as publish:
            runner.process(7)
            self.assertIn('changed during evaluation', publish.call_args.args[1][0])

    def test_changed_pr_metadata_publishes_failure_on_same_head(self):
        pr = {'number': 7, 'state': 'open', 'head': {'sha': 'head', 'ref': 'feature/monorepo-3-fix'},
              'base': {'sha': 'base', 'ref': 'main'}, 'body': 'Issue: #3', 'draft': False}
        changed = copy.deepcopy(pr)
        changed['body'] = 'Issue: #4'
        with patch.object(runner, 'get_pr', return_value=changed), patch.object(runner, 'request') as request:
            runner.publish(pr, [], 1)
            self.assertEqual(request.call_args.args[1]['conclusion'], 'failure')
        changed['head']['sha'] = 'new-head'
        with patch.object(runner, 'get_pr', return_value=changed), patch.object(runner, 'request') as request:
            runner.publish(pr, [], 1)
            request.assert_not_called()

    def test_pages_follow_next_and_cap(self):
        with patch.object(runner, 'request', side_effect=[([1] * 100, '<https://api.github.com/page2>; rel="next"'), ([2], '')]):
            self.assertEqual(len(runner.pages('/path')), 101)
        with patch.object(runner, 'request', return_value=([1], '<https://api.github.com/more>; rel="next"')):
            with self.assertRaises(RuntimeError):
                runner.pages('/path')


if __name__ == '__main__':
    unittest.main()
