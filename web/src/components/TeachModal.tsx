import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { keys } from '../lib/queries';
import { Button, Field, Modal, Switch, Textarea } from './ui';

/** Turns a real question (knowledge gap or a weak AI reply) into a training example. */
export function TeachModal({
  consultantId,
  open,
  onClose,
  question,
  reply = '',
  source,
}: {
  consultantId: string;
  open: boolean;
  onClose: () => void;
  question: string;
  reply?: string;
  source: 'gap' | 'conversation';
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [q, setQ] = useState(question);
  const [a, setA] = useState(reply);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (open) {
      setQ(question);
      setA(reply);
      setPinned(false);
    }
  }, [open, question, reply]);

  const save = useMutation({
    mutationFn: () =>
      api(`/consultants/${consultantId}/examples`, {
        method: 'POST',
        body: { customer_message: q.trim(), ideal_reply: a.trim(), is_pinned: pinned, source },
      }),
    onSuccess: () => {
      toast.success(t.teach.saved);
      void qc.invalidateQueries({ queryKey: keys.examples(consultantId) });
      void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.teach.title}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!q.trim() || !a.trim()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t.teach.question}>{(id) => <Textarea id={id} rows={3} value={q} onChange={(e) => setQ(e.target.value)} maxLength={4000} />}</Field>
        <Field label={t.teach.answer}>
          {(id) => <Textarea id={id} rows={6} value={a} onChange={(e) => setA(e.target.value)} placeholder={t.teach.answerPlaceholder} maxLength={4000} autoFocus />}
        </Field>
        <Switch checked={pinned} onChange={setPinned} label={t.teach.pin} />
      </div>
    </Modal>
  );
}
