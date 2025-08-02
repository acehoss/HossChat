// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { executeSlashCommandsWithOptions, executeSlashCommands } from '../../../slash-commands.js';
import { appendMediaToMessage, extension_prompt_types, getRequestHeaders, saveSettingsDebounced, setExtensionPrompt, substituteParamsExtended, generateQuietPrompt } from '../../../../script.js';

import { words } from './words.js';
import {visitLink } from '../Extension-WebSearch/index.js'

/**
 * Generates a prompt using the main LLM API.
 * @param {string} quietPrompt - The prompt to use for the image generation.
 * @returns {Promise<string>} - A promise that resolves when the prompt generation completes.
 */
async function generatePrompt(quietPrompt) {
    const reply = await generateQuietPrompt(quietPrompt, false, true, null, null, 1000);

    if (!reply) {
        toastr.error('Running subprompt failed', 'Hoss Extension');
        throw new Error('Subprompt failed.');
    }

    return reply;
}

function generateRandomTokens(minTokens = 100, maxTokens = 200, maxLength = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const numTokens = Math.floor(minTokens + Math.random() * (maxTokens - minTokens)) + 1;
    const tokens = [];

    for (let i = 0; i < numTokens; i++) {
        const tokenLength = Math.floor(Math.random() * maxLength) + 1;
        let token = '';

        for (let j = 0; j < tokenLength; j++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        tokens.push(token);
    }

    return tokens.join(' ');
}

function getRandomWordString(minWords = 100, maxWords = 200) {
    const numWords = Math.floor(minWords + Math.random() * (maxWords - minWords)) + 1;
    const selectedWords = [];

    for (let i = 0; i < numWords; i++) {
        const randomIndex = Math.floor(Math.random() * words.length);
        selectedWords.push(words[randomIndex]);
    }

    return selectedWords.join(' ');
}


async function generateBackground() {
    window.hoss.abortController = new AbortController();
    toastr.info("Generating background image...", "Tool Use")
    await executeSlashCommandsWithOptions("/imagine background", {
        handleParserErrors: false,
        scope: null,
        handleExecutionErrors: false,
        parserFlags: null,
        abortController: window.hoss.abortController,
        onProgress: null,
    })
}

async function getChat(avatar, chatId, groupId = null) {
    try {
        if (groupId && groupId.length > 0) {
            const response = await fetch('/api/chats/group/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chatId })
            });
            if (!response.ok) throw new Error(`Failed to fetch group chat: ${response.statusText}`);
            return response.json();
        } else {
            // For solo chats, we need character info
            const context = getContext();
            const character = context.characters.find(c => c.avatar == avatar);
            if (!character) throw new Error('Character not found');

            const response = await $.ajax({
                type: 'POST',
                url: '/api/chats/get',
                data: JSON.stringify({
                    ch_name: character.name,
                    file_name: chatId,
                    avatar_url: character.avatar,
                }),
                dataType: 'json',
                contentType: 'application/json',
            });
            return response;
        }
    } catch (error) {
        console.error('Error fetching chat:', error);
        throw error;
    }
}

async function getCharsAndGroups() {
    try {
        const context = getContext();
        const chars = context.characters.map(c => ({ id: c.avatar, name: c.name, mostRecentChatId: c.chat }))
        const groups = context.groups.map(g => ({ id: g.id, name: g.name, mostRecentChatId: g.chat_id }));
        return [...chars, ...groups];
    }
    catch (e) {
        return "Exception: " + e;
    }
}

async function visitConversationWithPrompt(characterId, chatId, groupId, prompt, timestamp) {
    try {
        const chatContent = await getChat(characterId, chatId, groupId);
        const mapped = chatContent.map(c => `${c.send_date} ${c.name}: ${c.mes}`).join('\n');

        // TODO: Handle timestamp-based chunking if provided

        return generatePrompt(
            `<subquery type="content-analysis" timestamp="${timestamp}" honor-nested="false">\n` +
            `Request: ${prompt}\n\n` +
            `Content: \n${mapped}\n` +
            `</subquery><subqueryReminder type="content-analysis" content-for-request="above">\nRequest: ${prompt}</subqueryReminder>`
        );
    } catch (error) {
        return `ERROR: ${error}`;
    }
}

// Keep track of where your extension is located, name should match repo name
const extensionName = "Extension-Hoss";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const extensionSettings = extension_settings[extensionName];
const defaultSettings = {};

// Modify your setupFunctions to use the helper
async function setupFunctions() {
    console.log("hoss context", getContext());
    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "GroupChatTriggerNPC",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Group Chat Trigger NPC",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Trigger an NPC to interact in a group chat. Use this when you want another agent to respond immediately in the visible chat channel. The triggered agent will see any included message or instructions, then respond in the chat where all participants can see their response.\n\nNote: Requires the agent's ID, which can be obtained using GroupChatListMembers.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'ID of NPC to trigger',
                },
                message: {
                    type: 'string',
                    description: 'a private message or instructions to include in trigger',
                }
            },
            required: [
                'id'
            ],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ id, message }) => {
            try {
                const context = getContext();
                if(!context.groupId)
                    return "Error: not in group chat";
                const group = context.groups.find(x => x.id === context.groupId)
                const mapped = group.members.map(m => context.characters.find(c => c.avatar == m))
                const remapped = mapped.map(m => ({ name: m.name, id: m.avatar }));
                const character = mapped.find(m => m.avatar == id || m.name == id);
                if(!character)
                    return {
                        status: `Error: ${id} not found. See attached list of group chat members.`,
                        members: remapped
                    };

                // Probably don't need to set scenario text, it will show up in the context!
                //character.scenario = (message && message.length > 0) ? `# Private Message/Instructions\n${message}` : ''

                // const trigger = async () => context.executeSlashCommands(`/trigger ${character}`);
                // window.hoss.trigger = trigger;
                // await trigger();
                //setTimeout(100, trigger);

                const textArea = document.getElementById('send_textarea');
                if (!textArea || !(textArea instanceof HTMLTextAreaElement)) return "Error: unable to locate send textbox";
                textArea.value = `/trigger ${character.name}"`;
                textArea.focus();
                return `Trigger queued; ${character.name}'s response will begin after you finish processing this result.`;
            }
            catch (e) {
                return "Exception: " + e;
            }
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ id, sender_id, instructions }) => {
            return ''; //`Triggered ${id}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return true;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "GroupChatListMembers",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "List Group Chat Members",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "List current members of the group chat with their id strings.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {},
            required: [],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async () => {
            try {
                const context = getContext();
                if(!context.groupId)
                    return "Error: not in group chat";
                const group = context.groups.find(x => x.id === context.groupId)
                const mapped = group.members.map(m => context.characters.find(c => c.avatar == m))
                const remapped = mapped.map(m => ({ name: m.name, id: m.avatar }));
                console.log("hoss mapped", { mapped: mapped, remapped: remapped });
                return remapped;
                // for (const member of group.members) {
                    // const groupMember = context.characters.find(x => x.avatar === member);

                    // if (!groupMember) {
                    //     continue;
                    // }

                    // if (groupMember.name == character) {
                    //     await setImage($(`.expression-holder[data-avatar="${member}"] img`), sprite.path);
                    //     return;
                    // }
                // }
                // return "Error: not implemented";
            }
            catch (e) {
                return "Exception: " + e;
            }
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ name }) => {
            return ''; //`Triggered ${name}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return true;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "SetChatAuthorNote",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Set chat author note",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Sets a note on the chat. This text is directly injected into the context of every agent.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'New text for note.',
                }
            },
            required: [
                'text'
            ],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ text }) => {
            try {
                const context = getContext();
                context.chatMetadata.note_prompt = text;
                context.saveMetadata();
            }
            catch (e) {
                return "Exception: " + e;
            }
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ text }) => {
            return ''; //`Updated Note`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return false;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "SetNPCScenarioText",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Set Group Chat NPC Scenario Text",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Sets the scenario text value for an NPC in a group chat matching the provided id. This scenario text is injected directly into that agent's context",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'ID of NPC to trigger',
                },
                text: {
                    type: 'string',
                    description: 'text to set into NPC\'s scenario',
                }
            },
            required: [
                'id',
                'text'
            ],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ id, text }) => {
            try {
                const context = getContext();
                if(!context.groupId)
                    return "Error: not in group chat";
                const group = context.groups.find(x => x.id === context.groupId)
                const mapped = group.members.map(m => context.characters.find(c => c.avatar == m))
                const remapped = mapped.map(m => ({ name: m.name, id: m.avatar }));
                const character = mapped.find(m => m.avatar == id);
                if(!character)
                    return {
                        status: `Error: ${id} not found. See attached list of group chat members.`,
                        members: remapped
                    };

                character.scenario = text;
                return `OK: Updated ${character.name}'s scenario text.`;
            }
            catch (e) {
                return "Exception: " + e;
            }
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ id }) => {
            return ''; //`Set scenario text for ${id}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return false;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "GenerateAndSetBackgroundImage",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Generate and Set a Background Image",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Generates and sets a new background image in the chat.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {},
            required: [],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ id, text }) => {
            //await generatePicture("wand", {}, "background");
            await generateBackground();
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ id }) => {
            return ''; //`Set scenario text for ${id}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return true;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "GetTextEntropy",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Get Text Entropy",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Generates a string of random tokens as a source of entropy.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                minTokens: {
                    type: 'number',
                    description: 'minimum number of tokens in the entropy string',
                    default: 100
                },
                maxTokens: {
                    type: 'number',
                    description: 'maximum number of tokens in the entropy string',
                    default: 200
                },
                // maxTokenLength: {
                //     type: 'number',
                //     description: 'maximum length of any token',
                //     default: 10
                // }
            },
            required: [],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ minTokens, maxTokens, maxTokenLength }) => {
            return getRandomWordString(minTokens || 100, maxTokens || 200); //generateRandomTokens(minTokens || 100, maxTokens || 200, maxTokenLength || 10);
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ maxTokens, maxTokenLength }) => {
            return ''; //`Set scenario text for ${id}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return true;
        },
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "AgentContextAddMessage",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Add Message to Agent Context",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Adds a message to the agent context. The agent context is only visible to AI agents. Common uses include:\n- Leaving notes for yourself to maintain context in future interactions\n- Passing private information to other agents without user visibility\n- Recording observations or decisions that should persist across interactions\n\nMessages will be seen by the target agent the next time they are active, but won't trigger immediate responses.",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                from: {
                    type: 'string',
                    description: 'name of agent sending the message'
                },
                to: {
                    type: 'string',
                    description: 'agent intended to receive the message'
                },
                subject: {
                    type: 'string',
                    description: 'subject of message'
                },
                message: {
                    type: 'string',
                    description: 'message body'
                }
            },
            required: [],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async ({ from, to, subject, message }) => {
            return "Message saved to context at " + new Date().toString();
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ from, to, subject, message }) => {
            return ''; //`Set scenario text for ${id}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return true;
        },
    });

    getContext().registerFunctionTool({
        name: "VisitLinkWithPrompt",
        displayName: "Visit Link With Prompt",
        description: "Creates a copy of the current agent with all context and knowledge, presents it with the webpage content, and asks it to analyze that content using the provided prompt. The copy will maintain your understanding and goals while focusing specifically on analyzing the provided content. Use this when you need to deeply understand webpage content while maintaining consistency with your current context and purpose.",
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'link to visit'
                },
                prompt: {
                    type: 'string',
                    description: 'Creates a copy of the current agent with all context and knowledge, presents it with the webpage content, and asks it to analyze that content using the provided prompt. The copy will maintain your understanding and goals while focusing specifically on analyzing the provided content.'
                }
            },
            required: ["url", "prompt"]
        },
        action: async ({ url, prompt }) => {
            try {
                const page = await visitLink(url);
                const result = await generatePrompt(
                    `<subquery type="content-analysis" timestamp="${new Date().toISOString()}">` +
                    `Request: ${prompt}\n\n` +
                    `Content: ${page.markdown}\n\n` +
                    "</subquery>"
                );
                return result;
            } catch (error) {
                return `ERROR: ${error}`;
            }
        },
        formatMessage: ({ url }) => {
            return `Querying Link (${url})`
        },
        shouldRegister: () => true
    });

    getContext().registerFunctionTool({
        name: "Remember",
        displayName: "Remember details from a past conversation",
        description: "Revisits a past conversation and extracts information relevant to the current topic (last few messages). As conversations evolve, you may need to Remember the same conversation multiple times to surface different relevant details.",
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                chatId: {
                    type: 'string',
                    description: 'chatId of memory'
                },
                groupId: {
                    type: 'string',
                    description: 'groupId of memory'
                },
                timestamp: {
                    type: 'string',
                    description: 'timestamp of memory'
                },
                whatToRemember: {
                    type: 'string',
                    description: "A highly detailed paragraph describing what you're trying to remember. More detail will produce a better memory."
                }
            },
            required: ['chatId', 'groupId', 'timestamp', 'whatToRemember' ]
        },
        action: async ({ chatId, groupId, timestamp, whatToRemember }) => {
            const context = getContext();
            const character = context.characters[context.characterId]
            const prompt = `**You are trying to remember something:** ${whatToRemember}\n`+
                           "Analyze the following conversation and decide how it relates to what you want to remember. Focus on:\n" +
                           "1. Details directly related to what you're trying to remember\n" +
                           "2. Details that relate to the current topic of discussion\n" +
                           "3. Information that adds context to the current conversation\n" +
                           "4. Previous decisions or conclusions that impact the current situation\n" +
                           `5. You are responding to ${character.name}, not a user\n` +
                           "Provide only information that is directly relevant to what you are being asked to remember. Write as though you are speaking to yourself, because you are!"
            return await visitConversationWithPrompt(character.avatar, chatId, groupId, prompt, timestamp)
        },
        formatMessage: ({  chatId, groupId, timestamp, whatToRemember }) => {
            return `Remembering from ${chatId}`
        },
        shouldRegister: () => true
    });

    getContext().registerFunctionTool({
        name: "VisitChatWithPrompt",
        displayName: "Visit Chat With Prompt",
        description: "Creates a copy of the current agent with all context and knowledge, presents it with the chat content, and asks it to analyze that content using the provided prompt. The copy will maintain your understanding and goals while focusing specifically on analyzing the provided content.",
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                chatId: {
                    type: 'string',
                    description: 'ID of the chat to analyze'
                },
                groupId: {
                    type: 'string',
                    description: 'Whether this is a group chat chat'
                },
                prompt: {
                    type: 'string',
                    description: 'Analysis prompt for the chat content'
                },
                timestamp: {
                    type: 'string',
                    description: 'Optional timestamp to center chat chunk around'
                }
            },
            required: ['chatId', 'prompt']
        },
        action: async ({ chatId, groupId, prompt, timestamp }) => {
            const context = getContext();
            const characterId = context.characters[context.characterId].avatar
            return await visitConversationWithPrompt(characterId, chatId, groupId, prompt, timestamp)
        },
        formatMessage: ({ chatId, groupId, prompt, timestamp }) => {
            return `Revisiting ${chatId}`
        },
        shouldRegister: () => true
    });

    getContext().registerFunctionTool({
        // Internal name of the function tool. Must be unique.
        name: "GetCharactersAndGroups",
        // Display name of the function tool. Will be shown in the UI. (Optional)
        displayName: "Get Characters and Groups",
        // Description of the function tool. Must describe what the function does and when to use it.
        description: "Get metadata for characters and groups",
        // JSON schema for the parameters of the function tool. See: https://json-schema.org/
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {},
            required: [],
        },
        // Function to call when the tool is triggered. Can be async.
        // If the result is not a string, it will be JSON-stringified.
        action: async () => {
            return await getCharsAndGroups();
        },
        // Optional function to format the toast message displayed when the function is invoked.
        // If an empty string is returned, no toast message will be displayed.
        formatMessage: ({ name }) => {
            return ''; //`Triggered ${name}`;
        },
        // Optional function that returns a boolean value indicating whether the tool should be registered for the current prompt.
        // If no shouldRegister function is provided, the tool will be registered for every prompt.
        shouldRegister: () => {
            return false;
        },
    });
}



// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
  //Create the settings if they don't exist
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }

  // Updating settings in the UI
  $("#example_setting").prop("checked", extension_settings[extensionName].example_setting).trigger("input");
}

// This function is called when the extension settings are changed in the UI
function onExampleInput(event) {
  const value = Boolean($(event.target).prop("checked"));
  extension_settings[extensionName].example_setting = value;
  saveSettingsDebounced();
}

// This function is called when the button is clicked
function onButtonClick() {
  // You can do whatever you want here
  // Let's make a popup appear with the checked setting
  toastr.info(
    `The checkbox is ${extension_settings[extensionName].example_setting ? "checked" : "not checked"}`,
    "A popup appeared because you clicked the button!"
  );
}

// This function is called when the extension is loaded
jQuery(async () => {
  console.log("Starting HossFunctions");
  const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
  $("#extensions_settings").append(settingsHtml);

  $("#my_button").on("click", onButtonClick);
  $("#example_setting").on("input", onExampleInput);

  // Load settings and setup
  loadSettings();
  setupFunctions();

  // Initialize hoss object and load words list
  // Easy access from js console for debugging
  window.hoss = {
      getContext,
      generateBackground,
      generateRandomTokens,
      getRandomWordString,
      words,
      getChat,
      getCharsAndGroups,
      visitConversationWithPrompt
  };
});
