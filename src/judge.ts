import { Agent } from '@mastra/core/agent';
import type { QuestionType } from './data.js';
import { judgeModel } from './models.js';
import { withRetry } from './retry.js';
import { type Usage, fromSdkUsage } from './usage.js';

/**
 * Official LongMemEval judge prompts, verbatim from
 * https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
 * (also used unchanged by Mastra's harness). Only the judge model differs: the paper
 * uses gpt-4o; this benchmark uses Claude Sonnet 4.6 on Bedrock.
 */
export function judgePrompt(type: QuestionType, question: string, answer: string, response: string, abstention: boolean): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: ${question}

Explanation: ${answer}

Model Response: ${response}

Does the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  switch (type) {
    case 'single-session-user':
    case 'single-session-assistant':
    case 'multi-session':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${response}

Is the model response correct? Answer yes or no only.`;
    case 'temporal-reasoning':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${response}

Is the model response correct? Answer yes or no only.`;
    case 'knowledge-update':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${response}

Is the model response correct? Answer yes or no only.`;
    case 'single-session-preference':
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: ${question}

Rubric: ${answer}

Model Response: ${response}

Is the model response correct? Answer yes or no only.`;
  }
}

const judgeAgent = new Agent({ id: 'judge', name: 'judge', instructions: '', model: judgeModel });

export async function judge(
  type: QuestionType,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): Promise<{ correct: boolean; raw: string; usage: Usage }> {
  const r: any = await withRetry(() =>
    judgeAgent.generate(judgePrompt(type, question, answer, response, abstention), {
      modelSettings: { temperature: 0, maxOutputTokens: 10 },
    }),
  );
  const raw = String(r.text ?? '').trim();
  return { correct: /^\W*yes\b/i.test(raw), raw, usage: fromSdkUsage(r.totalUsage ?? r.usage) };
}
