import tempfile
import unittest
from collab.core import Store

class Workflow(unittest.TestCase):
    def test_workflow_and_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            path=d+'/db.sqlite3'; s=Store(path)
            task=s.create('shortage','M-100',100,'2027-01-01','alice','create')['task_id']
            self.assertEqual(task,s.create('shortage','M-100',100,'2027-01-01','alice','create')['task_id'])
            with self.assertRaises(ValueError): s.create('different','M-100',100,'2027-01-01','alice','create')
            s.assign(task,'coordinator','assign')
            s=Store(path)
            for agent,qty in [('inventory',30),('supplier',90)]:
                result={'quantity':qty,'source':'simulated','observed_at':'2026-10-28T00:00:00Z'}
                self.assertEqual(s.submit(task,agent,result,agent),s.submit(task,agent,result,agent))
            self.assertEqual(s.summarize(task,'coordinator','summary')['shortage'],70)
            with self.assertRaises(ValueError): s.review(task,'bob',True,'','wrong')
            s.review(task,'alice',True,'accepted','review')
            kid=s.candidate(task,'check lead time','M-100','alice','candidate')['knowledge_id']
            self.assertEqual(s.knowledge(),[])
            s.publish(kid,'reviewer','9999-01-01T00:00:00+00:00','publish')
            task2=s.create('second','M-100',10,'2027-01-01','alice','create2')['task_id']
            s.reference(task2,kid,'coordinator','ref')
            s.revoke(kid,'reviewer','revoke')
            self.assertEqual(s.knowledge(),[])
            self.assertEqual(s.detail(task2)['knowledge_refs'][0]['version'],1)
            with self.assertRaises(ValueError): s.reference(task2,kid,'coordinator','ref2')

if __name__=='__main__': unittest.main()
