import { VercelMemoryStore } from "@/stores/vercel";
import {
  Annotation,
  END,
  MessagesAnnotation,
  SharedValue,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { z } from "zod";
import { BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { ChatAnthropic } from "@langchain/anthropic";
import { DEFAULT_SYSTEM_RULES } from "../constants";
import { UserRules } from "@/hooks/useGraph";

const DEFAULT_SYSTEM_RULES_STRING = `- ${DEFAULT_SYSTEM_RULES.join("\n- ")}`;
const DEFAULT_RULES_STRING = "*no rules have been set yet*";

const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  /**
   * Shared user rules on how to generate text.
   * Use `assistant_id` so it matches the assistant,
   * and can be shared across users.
   */
  userRules: SharedValue.on("assistant_id"),
  /**
   * Whether or not writing content was generated in the conversation.
   */
  contentGenerated: Annotation<boolean>(),
  /**
   * The user rules defined in the shared value.
   * @TODO remove once api for fetching shared values is available.
   */
  rules: Annotation<UserRules>(),
});

const GraphConfig = Annotation.Root({
  /**
   * The system rules to always include when generating responses.
   * This is editable by the user.
   */
  systemRules: Annotation<string>,
  /**
   * Whether or not the user has accepted the text generated by the AI.
   * If this is true, the graph will route to a node which generates rules.
   */
  hasAcceptedText: Annotation<boolean>(),
  /**
   * Whether or not to only get the rules.
   * @TODO remove once api for fetching shared values is available.
   */
  onlyGetRules: Annotation<boolean>(),
});

const RULES_PROMPT = `The user has defined two sets of rules. The first set is for style guidelines, and the second set is for content guidelines.

<style_rules>
{styleRules}
</style_rules>

<content_rules>
{contentRules}
</content_rules>`;

const SYSTEM_PROMPT = `You are a helpful assistant tasked with thoughtfully fulfilling the requests of the user.

System rules:

<system_rules>
{systemRules}
</system_rules>

{rulesPrompt}`;

const callModel = async (
  state: typeof GraphAnnotation.State,
  config?: RunnableConfig
) => {
  const model = new ChatAnthropic({
    model: "claude-3-5-sonnet-20240620",
    temperature: 0,
  });

  let styleRules: string | undefined;
  let contentRules: string | undefined;
  if (state.userRules) {
    if (state.userRules.styleRules?.length) {
      styleRules = `- ${state.userRules.styleRules.join("\n - ")}`;
    }
    if (state.userRules.contentRules?.length) {
      contentRules = `- ${state.userRules.contentRules.join("\n - ")}`;
    }
  }

  let systemPrompt = SYSTEM_PROMPT.replace(
    "{systemRules}",
    config?.configurable?.systemRules ?? DEFAULT_SYSTEM_RULES_STRING
  );
  if (styleRules || contentRules) {
    systemPrompt = systemPrompt
      .replace("{rulesPrompt}", RULES_PROMPT)
      .replace("{styleRules}", styleRules || DEFAULT_RULES_STRING)
      .replace("{contentRules}", contentRules || DEFAULT_RULES_STRING);
  } else {
    systemPrompt.replace("{rulesPrompt}", "");
  }

  const response = await model.invoke(
    [
      {
        role: "system",
        content: systemPrompt,
      },
      ...state.messages,
    ],
    config
  );
  return { messages: [response] };
};

const _prepareConversation = (messages: BaseMessage[]): string => {
  return messages
    .map((msg, i) => {
      if (typeof msg.content !== "string") return "";
      return `<${msg._getType()}_message index={${i}}>\n${msg.content}\n</${msg._getType()}_message>`;
    })
    .join("\n\n");
};

/**
 * This node generates insights based on the changes, or followup messages
 * that have been made by the user. It does the following:
 * 1. Sets a system message describing the task, and existing user rules, and how messages in the history can be formatted. (e.g an AI Message, followed by a human message that is prefixed with "REVISED MESSAGE").
 * 2. Passes the entire history to the LLM
 * 3. Uses `withStructuredOutput` to generate structured rules based on conversation or revisions.
 * 4. Updates the `userRules` shared value with the new rules.
 *
 * The LLM will always re-generate the entire rules list, so it is important to pass the entire history to the model.
 * @param state The current state of the graph
 */
const generateInsights = async (
  state: typeof GraphAnnotation.State,
  config?: RunnableConfig
) => {
  const systemPrompt = `This conversation contains back and fourth between an AI assistant, and a user who is using the assistant to generate text.

User messages which are prefixed with "REVISED MESSAGE" contain the entire revised text the user made to the assistant message directly before in the conversation.
Revisions are made directly by users, so you should pay VERY close attention to every single change made, no matter how small. These should be heavily considered when generating rules.

Important aspects of revisions to consider:
- Deletions: What did the user remove? Do you need a rule to avoid adding this in the future?
- Tone: Did they change the overall tone? Do you need a rule to ensure this tone is maintained?
- Structure: Did they change the structure of the text? This is important to remember, as it may be a common pattern. 

There also may be additional back and fourth between the user and the assistant.

Based on the conversation, and paying particular attention to any changes made in the "REVISED MESSAGE", your job is to create a list of rules to use in the future to help the AI assistant better generate text.

These rules should be split into two categories:
1. Style guidelines: These rules should focus on the style, tone, and structure of the text.
2. Content guidelines: These rules should focus on the content, context, and purpose of the text. Think of this as the business logic or domain-specific rules.

In your response, include every single rule you want the AI assistant to follow in the future. You should list rules based on a combination of the existing conversation as well as previous rules.
You can modify previous rules if you think the new conversation has helpful information, or you can delete old rules if they don't seem relevant, or you can add new rules based on the conversation.

Refrain from adding overly generic rules like "follow instructions". These generic rules are already outlined in the "system_rules" below.
Instead, focus your attention on specific details, writing style, or other aspects of the conversation that you think are important for the AI to follow.

The user has defined the following rules:

<style_rules>
{styleRules}
</style_rules>

<content_rules>
{contentRules}
</content_rules>

Here is the conversation:

<conversation>
{conversation}
</conversation>

And here are the default system rules:

<system_rules>
{systemRules}
</system_rules>

Respond with updated rules to keep in mind for future conversations. Try to keep the rules you list high signal-to-noise - don't include unnecessary ones, but make sure the ones you do add are descriptive. Combine ones that seem similar and/or contradictory`;

  let styleRules = DEFAULT_RULES_STRING;
  let contentRules = DEFAULT_RULES_STRING;
  if (state.userRules) {
    if (state.userRules.styleRules?.length) {
      styleRules = `- ${state.userRules.styleRules.join("\n - ")}`;
    }
    if (state.userRules.contentRules?.length) {
      contentRules = `- ${state.userRules.contentRules.join("\n - ")}`;
    }
  }

  const prompt = systemPrompt
    .replace(
      "{systemRules}",
      config?.configurable?.systemRules ?? DEFAULT_SYSTEM_RULES_STRING
    )
    .replace("{styleRules}", styleRules)
    .replace("{contentRules}", contentRules)
    .replace("{conversation}", _prepareConversation(state.messages));

  const userRulesSchema = z.object({
    contentRules: z
      .array(z.string())
      .describe(
        "List of rules focusing on content, context, and purpose of the text"
      ),
    styleRules: z
      .array(z.string())
      .describe(
        "List of rules focusing on style, tone, and structure of the text"
      ),
  });

  const modelWithStructuredOutput = new ChatAnthropic({
    model: "claude-3-5-sonnet-20240620",
    temperature: 0,
  }).withStructuredOutput(userRulesSchema, { name: "userRules" });

  const result = await modelWithStructuredOutput.invoke(
    [
      {
        role: "user",
        content: prompt,
      },
    ],
    config
  );

  return {
    userRules: {
      ...result,
    },
    userAcceptedText: false,
  };
};

const wasContentGenerated = async (state: typeof GraphAnnotation.State) => {
  const { messages } = state;

  const prompt = `Given the following conversation between a user and an AI assistant, determine whether or not writing content (think, a blog post, or tweet) was generated by the assistant, or if it's just a conversation.
If writing content was generated, set 'contentGenerated' to true, otherwise set it to false.

<conversation>
{conversation}
</conversation>`;
  const schema = z.object({
    contentGenerated: z
      .boolean()
      .describe(
        "Whether or not content (e.g a tweet, or blog post) was generated in the conversation history."
      ),
  });
  // TODO remove rules section to only include conversation.
  const formattedPrompt = prompt.replace(
    "{conversation}",
    _prepareConversation(messages)
  );
  const model = new ChatAnthropic({
    model: "claude-3-haiku-20240307",
    temperature: 0,
  }).withStructuredOutput(schema, { name: "was_content_generated" });

  return model.invoke([
    {
      role: "user",
      content: formattedPrompt,
    },
  ]);
};

const shouldCheckContentGeneration = (state: typeof GraphAnnotation.State) => {
  if (state.contentGenerated) {
    return END;
  } else {
    return "wasContentGenerated";
  }
};

const getRules = (state: typeof GraphAnnotation.State) => {
  return {
    rules: state.userRules,
  };
};

/**
 * Conditional edge which is always called first. This edge
 * determines whether or not revisions have been made, and if so,
 * generate insights to then set under user rules.
 * @param {typeof GraphAnnotation.State} state The current state of the graph
 */
const shouldGenerateInsights = (
  _state: typeof GraphAnnotation.State,
  config?: RunnableConfig
) => {
  const { hasAcceptedText, onlyGetRules } = {
    hasAcceptedText: false,
    onlyGetRules: false,
    ...(config?.configurable || {}),
  };

  if (onlyGetRules) {
    return "getRules";
  }
  if (hasAcceptedText) {
    return "generateInsights";
  }
  return "callModel";
};

export function buildGraph(store?: VercelMemoryStore) {
  const workflow = new StateGraph(GraphAnnotation, GraphConfig)
    .addNode("callModel", callModel)
    .addNode("generateInsights", generateInsights)
    .addNode("wasContentGenerated", wasContentGenerated)
    // At this time there isn't a good way to fetch values from the store
    // so instead we have a node which can return them.
    .addNode("getRules", getRules)
    // Always start by checking whether or not to generate insights
    .addConditionalEdges(START, shouldGenerateInsights)
    // Always check if content was generated after calling the model
    .addConditionalEdges("callModel", shouldCheckContentGeneration)
    // No further action by the graph is necessary after either
    // generating a response via `callModel`, or rules via `generateInsights`.
    .addEdge("generateInsights", END)
    .addEdge("wasContentGenerated", END)
    .addEdge("getRules", END);

  return workflow.compile({
    store,
  });
}
