/** Copy owned by the Quote interaction plugin. */

/** Quote plugin dictionary namespace. */
export const NS = 'messageQuotes'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'quote.add': '引用文本',
  'annotation.ask': '提问',
  'annotation.explain': '解释',
  'annotation.ask.placeholder': '针对引用文本输入你的问题…',
  'annotation.ask.submit': '提问',
  'annotation.cancel': '取消',
  'annotation.tab.title': '批注',
  'annotation.empty': '还没有批注。选中对话中的文本，点击「提问」或「解释」。',
  'annotation.kind.ask': '提问',
  'annotation.kind.explain': '解释',
  'annotation.question': '问题：',
  'annotation.pending': '正在生成…',
  'annotation.failed': '生成失败',
  'annotation.retry': '重试',
  'annotation.remove': '删除批注',
  'annotation.reveal': '定位到对话中的引用文本',
  'annotation.expand': '展开批注',
  'annotation.collapse': '折叠批注',
}

/** Supported Quote interaction copy keys. */
export type MessageQuotesKey = keyof typeof zh

/** English dictionary. */
export const en: Record<MessageQuotesKey, string> = {
  'quote.add': 'Quote text',
  'annotation.ask': 'Ask',
  'annotation.explain': 'Explain',
  'annotation.ask.placeholder': 'Ask about the quoted text…',
  'annotation.ask.submit': 'Ask',
  'annotation.cancel': 'Cancel',
  'annotation.tab.title': 'Annotations',
  'annotation.empty': 'No annotations yet. Select text in the conversation and choose Ask or Explain.',
  'annotation.kind.ask': 'Ask',
  'annotation.kind.explain': 'Explain',
  'annotation.question': 'Question: ',
  'annotation.pending': 'Generating…',
  'annotation.failed': 'Generation failed',
  'annotation.retry': 'Retry',
  'annotation.remove': 'Delete annotation',
  'annotation.reveal': 'Reveal the quoted text in the conversation',
  'annotation.expand': 'Expand annotation',
  'annotation.collapse': 'Collapse annotation',
}

/** Japanese dictionary. */
export const ja = {
  'quote.add': 'テキストを引用',
  'annotation.ask': '質問',
  'annotation.explain': '説明',
  'annotation.ask.placeholder': '引用テキストについて質問を入力…',
  'annotation.ask.submit': '質問',
  'annotation.cancel': 'キャンセル',
  'annotation.tab.title': '注釈',
  'annotation.empty': '注釈はまだありません。会話のテキストを選択して「質問」または「説明」をクリックしてください。',
  'annotation.kind.ask': '質問',
  'annotation.kind.explain': '説明',
  'annotation.question': '質問：',
  'annotation.pending': '生成中…',
  'annotation.failed': '生成に失敗しました',
  'annotation.retry': '再試行',
  'annotation.remove': '注釈を削除',
  'annotation.reveal': '会話内の引用テキストに移動',
  'annotation.expand': '注釈を展開',
  'annotation.collapse': '注釈を折りたたむ',
} satisfies Record<MessageQuotesKey, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'quote.add': 'Texto de cotización',
  'annotation.ask': 'Preguntar',
  'annotation.explain': 'Explicar',
  'annotation.ask.placeholder': 'Pregunta sobre el texto citado…',
  'annotation.ask.submit': 'Preguntar',
  'annotation.cancel': 'Cancelar',
  'annotation.tab.title': 'Anotaciones',
  'annotation.empty': 'Aún no hay anotaciones. Selecciona texto en la conversación y elige Preguntar o Explicar.',
  'annotation.kind.ask': 'Pregunta',
  'annotation.kind.explain': 'Explicación',
  'annotation.question': 'Pregunta: ',
  'annotation.pending': 'Generando…',
  'annotation.failed': 'Error al generar',
  'annotation.retry': 'Reintentar',
  'annotation.remove': 'Eliminar anotación',
  'annotation.reveal': 'Mostrar el texto citado en la conversación',
  'annotation.expand': 'Expandir anotación',
  'annotation.collapse': 'Contraer anotación',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'quote.add': 'Texte de citation',
  'annotation.ask': 'Question',
  'annotation.explain': 'Expliquer',
  'annotation.ask.placeholder': 'Posez une question sur le texte cité…',
  'annotation.ask.submit': 'Question',
  'annotation.cancel': 'Annuler',
  'annotation.tab.title': 'Annotations',
  'annotation.empty': 'Aucune annotation. Sélectionnez du texte dans la conversation puis choisissez Question ou Expliquer.',
  'annotation.kind.ask': 'Question',
  'annotation.kind.explain': 'Explication',
  'annotation.question': 'Question : ',
  'annotation.pending': 'Génération…',
  'annotation.failed': 'Échec de la génération',
  'annotation.retry': 'Réessayer',
  'annotation.remove': "Supprimer l'annotation",
  'annotation.reveal': 'Afficher le texte cité dans la conversation',
  'annotation.expand': "Développer l'annotation",
  'annotation.collapse': "Réduire l'annotation",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'quote.add': 'Zitattext',
  'annotation.ask': 'Fragen',
  'annotation.explain': 'Erklären',
  'annotation.ask.placeholder': 'Frage zum zitierten Text eingeben…',
  'annotation.ask.submit': 'Fragen',
  'annotation.cancel': 'Abbrechen',
  'annotation.tab.title': 'Anmerkungen',
  'annotation.empty': 'Noch keine Anmerkungen. Markieren Sie Text in der Unterhaltung und wählen Sie Fragen oder Erklären.',
  'annotation.kind.ask': 'Frage',
  'annotation.kind.explain': 'Erklärung',
  'annotation.question': 'Frage: ',
  'annotation.pending': 'Wird generiert…',
  'annotation.failed': 'Generierung fehlgeschlagen',
  'annotation.retry': 'Erneut versuchen',
  'annotation.remove': 'Anmerkung löschen',
  'annotation.reveal': 'Zitierten Text in der Unterhaltung anzeigen',
  'annotation.expand': 'Anmerkung ausklappen',
  'annotation.collapse': 'Anmerkung einklappen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'quote.add': 'Текст цитаты',
  'annotation.ask': 'Спросить',
  'annotation.explain': 'Пояснить',
  'annotation.ask.placeholder': 'Введите вопрос о цитируемом тексте…',
  'annotation.ask.submit': 'Спросить',
  'annotation.cancel': 'Отмена',
  'annotation.tab.title': 'Примечания',
  'annotation.empty': 'Примечания пока отсутствуют. Выделите текст в диалоге и нажмите «Спросить» или «Пояснить».',
  'annotation.kind.ask': 'Вопрос',
  'annotation.kind.explain': 'Пояснение',
  'annotation.question': 'Вопрос: ',
  'annotation.pending': 'Генерация…',
  'annotation.failed': 'Ошибка генерации',
  'annotation.retry': 'Повторить',
  'annotation.remove': 'Удалить примечание',
  'annotation.reveal': 'Показать цитируемый текст в диалоге',
  'annotation.expand': 'Развернуть примечание',
  'annotation.collapse': 'Свернуть примечание',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'quote.add': 'Citação de texto',
  'annotation.ask': 'Perguntar',
  'annotation.explain': 'Explicar',
  'annotation.ask.placeholder': 'Pergunte sobre o texto citado…',
  'annotation.ask.submit': 'Perguntar',
  'annotation.cancel': 'Cancelar',
  'annotation.tab.title': 'Anotações',
  'annotation.empty': 'Ainda não há anotações. Selecione texto na conversa e escolha Perguntar ou Explicar.',
  'annotation.kind.ask': 'Pergunta',
  'annotation.kind.explain': 'Explicação',
  'annotation.question': 'Pergunta: ',
  'annotation.pending': 'Gerando…',
  'annotation.failed': 'Falha ao gerar',
  'annotation.retry': 'Tentar novamente',
  'annotation.remove': 'Excluir anotação',
  'annotation.reveal': 'Mostrar o texto citado na conversa',
  'annotation.expand': 'Expandir anotação',
  'annotation.collapse': 'Recolher anotação',
} satisfies Record<keyof typeof en, string>
