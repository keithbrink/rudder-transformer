const { httpPOST } = require("../../../adapters/network");
const { EventType } = require("../../../constants");
const {
  CustomError,
  constructPayload,
  ErrorMessage,
  defaultRequestConfig,
  defaultPostRequestConfig,
  getValueFromMessage,
  getFieldValueFromMessage,
  defaultPutRequestConfig,
  isDefinedAndNotNull,
  extractCustomFields,
  getErrorRespEvents,
  getSuccessRespEvents
} = require("../../util");

const {
  MAPPING_CONFIG,
  CONFIG_CATEGORIES,
  BASE_URL_EU,
  BASE_URL,
  EVENT_NAME_MAPPING,
  BLUESHIFT_IDENTIFY_EXCLUSION
} = require("./config");

function checkValidEventName(str) {
  if (str.indexOf(".") !== -1 || /[0-9]/.test(str) || str.length > 64)
    return true;
  return false;
}

const trackResponseBuilder = async (message, category, { Config }) => {
  let event = getValueFromMessage(message, "event");
  if (!event) {
    throw new CustomError(
      "[Blueshift] property:: event is required for track call",
      400
    );
  }

  if (!Config.eventApiKey) {
    throw new CustomError(
      "[BLUESHIFT] event Api Keys required for Authentication.",
      400
    );
  }
  let payload = constructPayload(message, MAPPING_CONFIG[category.name]);

  if (!payload) {
    // fail-safety for developer error
    throw new CustomError(ErrorMessage.FailedToConstructPayload, 400);
  }

  event = event.trim();
  if (isDefinedAndNotNull(EVENT_NAME_MAPPING[event])) {
    payload.event = EVENT_NAME_MAPPING[event];
  }
  payload.event = payload.event.replace(/\s+/g, "_");
  if (checkValidEventName(payload.event)) {
    throw new CustomError(
      "[Blueshift] Event shouldn't contain period(.), numeric value and contains not more than 64 characters",
      400
    );
  }
  payload = extractCustomFields(message, payload, ["properties"], ["cookie"]);

  const response = defaultRequestConfig();

  const baseURL = Config.datacenterEU ? BASE_URL_EU : BASE_URL;
  response.endpoint = `${baseURL}/api/v1/event`;

  response.method = defaultPostRequestConfig.requestMethod;
  const basicAuth = Buffer.from(Config.eventApiKey).toString("base64");
  response.headers = {
    Authorization: `Basic ${basicAuth}`,
    "Content-Type": "application/json"
  };
  response.body.JSON = payload;
  return response;
};

const identifyResponseBuilder = async (message, category, { Config }) => {
  if (!Config.usersApiKey) {
    throw new CustomError(
      "[BLUESHIFT] User API Key required for Authentication.",
      400
    );
  }
  let payload = constructPayload(message, MAPPING_CONFIG[category.name]);

  if (!payload) {
    // fail-safety for developer error
    throw new CustomError(ErrorMessage.FailedToConstructPayload, 400);
  }

  payload = extractCustomFields(
    message,
    payload,
    ["traits", "context.traits"],
    BLUESHIFT_IDENTIFY_EXCLUSION
  );
  const response = defaultRequestConfig();

  const baseURL = Config.datacenterEU ? BASE_URL_EU : BASE_URL;
  response.endpoint = `${baseURL}/api/v1/customers`;

  response.method = defaultPostRequestConfig.requestMethod;
  const basicAuth = Buffer.from(Config.usersApiKey).toString("base64");
  response.headers = {
    Authorization: `Basic ${basicAuth}`,
    "Content-Type": "application/json"
  };
  response.body.JSON = payload;
  return response;
};

const groupResponseBuilder = async (message, category, { Config }) => {
  if (!Config.usersApiKey) {
    throw new CustomError(
      "[BLUESHIFT] User API Key required for Authentication.",
      400
    );
  }

  const payload = constructPayload(message, MAPPING_CONFIG[category.name]);

  if (!payload) {
    // fail-safety for developer error
    throw new CustomError(ErrorMessage.FailedToConstructPayload, 400);
  }
  if (!payload.list_id) {
    if (payload.name && payload.description) {
      const baseURL = Config.datacenterEU ? BASE_URL_EU : BASE_URL;
      const endpoint = `${baseURL}/api/v1/custom_user_lists/create`;

      const basicAuth = Buffer.from(Config.usersApiKey).toString("base64");
      const requestOptions = {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${basicAuth}`
        }
      };
      const blueshiftlist = await httpPOST(endpoint, payload, requestOptions);
      if (blueshiftlist.success === true && blueshiftlist.response.data.id) {
        payload.list_id = blueshiftlist.response.data.id;
      } else {
        throw new CustomError(
          `[Blueshift]:: ${blueshiftlist.response.message}`,
          400
        );
      }
    } else {
      throw new CustomError(
        "[Blueshift]:: name and description are required to create an empty list, or List Id is required to add user.",
        400
      );
    }
  }

  const response = defaultRequestConfig();

  // identifier_value mapped with userId, so identifier_key takes customer_id.
  payload.identifier_key = "customer_id";

  const baseURL = Config.datacenterEU ? BASE_URL_EU : BASE_URL;
  response.endpoint = `${baseURL}/api/v1/custom_user_lists/add_user_to_list/${payload.list_id}`;

  response.method = defaultPutRequestConfig.requestMethod;
  const basicAuth = Buffer.from(Config.usersApiKey).toString("base64");
  response.headers = {
    Authorization: `Basic ${basicAuth}`,
    "Content-Type": "application/json"
  };
  response.body.JSON = payload;
  return response;
};

const process = async event => {
  const { message, destination } = event;
  if (!message.type) {
    throw new CustomError(
      "Message Type is not present. Aborting message.",
      400
    );
  }

  const messageType = message.type.toLowerCase();
  const category = CONFIG_CATEGORIES[message.type.toUpperCase()];

  let response;
  switch (messageType) {
    case EventType.TRACK:
      response = await trackResponseBuilder(message, category, destination);
      break;
    case EventType.IDENTIFY:
      response = await identifyResponseBuilder(message, category, destination);
      break;
    case EventType.GROUP:
      response = await groupResponseBuilder(message, category, destination);
      break;
    default:
      throw new CustomError(`Message type ${messageType} not supported`, 400);
  }
  return response;
};

const processRouterDest = async inputs => {
  if (!Array.isArray(inputs) || inputs.length <= 0) {
    const respEvents = getErrorRespEvents(null, 400, "Invalid event array");
    return [respEvents];
  }

  const respList = await Promise.all(
    inputs.map(async input => {
      try {
        if (input.message.statusCode) {
          // already transformed event
          return getSuccessRespEvents(
            input.message,
            [input.metadata],
            input.destination
          );
        }
        // if not transformed
        return getSuccessRespEvents(
          await process(input),
          [input.metadata],
          input.destination
        );
      } catch (error) {
        return getErrorRespEvents(
          [input.metadata],
          error.response
            ? error.response.status
            : error.code
            ? error.code
            : 400,
          error.message || "Error occurred while processing payload."
        );
      }
    })
  );
  return respList;
};

module.exports = { process, processRouterDest };
