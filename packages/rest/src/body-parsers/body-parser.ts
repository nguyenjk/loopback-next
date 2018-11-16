// Copyright IBM Corp. 2017,2018. All Rights Reserved.
// Node module: @loopback/rest
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  Constructor,
  Context,
  inject,
  instantiateClass,
} from '@loopback/context';
import {isReferenceObject, OperationObject} from '@loopback/openapi-v3-types';
import * as debugModule from 'debug';
import {is} from 'type-is';
import {RestBindings} from '../keys';
import {RestHttpErrors} from '../rest-http-error';
import {Request, RequestBodyParserOptions} from '../types';
import {
  getContentType,
  normalizeParsingError,
  BUILT_IN_PARSERS,
} from './body-parser.helpers';
import {JsonBodyParser} from './body-parser.json';
import {RawBodyParser} from './body-parser.raw';
import {StreamBodyParser} from './body-parser.stream';
import {TextBodyParser} from './body-parser.text';
import {UrlEncodedBodyParser} from './body-parser.urlencoded';
import {
  BodyParser,
  BodyParserFunction,
  RequestBody,
  REQUEST_BODY_PARSER_TAG,
} from './types';

const debug = debugModule('loopback:rest:body-parser');

export class RequestBodyParser {
  readonly parsers: BodyParser[];

  constructor(
    @inject(RestBindings.REQUEST_BODY_PARSER_OPTIONS, {optional: true})
    options: RequestBodyParserOptions = {},
    @inject.tag(REQUEST_BODY_PARSER_TAG, {optional: true})
    parsers?: BodyParser[],
    @inject.context() private readonly ctx?: Context,
  ) {
    if (!parsers || parsers.length === 0) {
      this.parsers = [
        new JsonBodyParser(options),
        new UrlEncodedBodyParser(options),
        new TextBodyParser(options),
        new StreamBodyParser(),
        new RawBodyParser(options),
      ];
    } else {
      this.parsers = sortParsers(parsers);
    }
    if (debug.enabled) {
      debug('Body parsers: ', this.parsers.map(p => p.name));
    }
  }

  async loadRequestBodyIfNeeded(
    operationSpec: OperationObject,
    request: Request,
  ): Promise<RequestBody> {
    const {requestBody, customParser} = await this._matchRequestBodySpec(
      operationSpec,
      request,
    );
    if (!operationSpec.requestBody) return requestBody;
    const matchedMediaType = requestBody.mediaType!;
    try {
      if (customParser) {
        // Invoke the custom parser
        const body = await this._invokeCustomParser(customParser, request);
        if (body !== undefined) return Object.assign(requestBody, body);
      }
      for (const parser of this.parsers) {
        if (!parser.supports(matchedMediaType)) {
          debug(
            'Body parser %s does not support %s',
            parser.name,
            matchedMediaType,
          );
          continue;
        }
        debug('Body parser %s found for %s', parser.name, matchedMediaType);
        const body = await parser.parse(request);
        return Object.assign(requestBody, body);
      }
    } catch (err) {
      throw normalizeParsingError(err);
    }

    throw RestHttpErrors.unsupportedMediaType(matchedMediaType);
  }

  /**
   * Match the http request to a given media type of the request body spec
   */
  private async _matchRequestBodySpec(
    operationSpec: OperationObject,
    request: Request,
  ) {
    const requestBody: RequestBody = {
      value: undefined,
    };
    if (!operationSpec.requestBody) return {requestBody};

    const contentType = getContentType(request) || 'application/json';
    debug('Loading request body with content type %j', contentType);

    // the type of `operationSpec.requestBody` could be `RequestBodyObject`
    // or `ReferenceObject`, resolving a `$ref` value is not supported yet.
    if (isReferenceObject(operationSpec.requestBody)) {
      throw new Error('$ref requestBody is not supported yet.');
    }

    let content = operationSpec.requestBody.content || {};
    if (!Object.keys(content).length) {
      content = {
        // default to allow json and urlencoded
        'application/json': {schema: {type: 'object'}},
        'application/x-www-form-urlencoded': {schema: {type: 'object'}},
      };
    }

    // Check of the request content type matches one of the expected media
    // types in the request body spec
    let matchedMediaType: string | false = false;
    let customParser = undefined;
    for (const type in content) {
      matchedMediaType = is(contentType, type);
      if (matchedMediaType) {
        debug('Matched media type: %s -> %s', type, contentType);
        requestBody.mediaType = contentType;
        requestBody.schema = content[type].schema;
        customParser = content[type]['x-parser'];
        break;
      }
    }

    if (!matchedMediaType) {
      // No matching media type found, fail fast
      throw RestHttpErrors.unsupportedMediaType(
        contentType,
        Object.keys(content),
      );
    }

    return {requestBody, customParser};
  }

  /**
   * Resolve and invoke a custom parser
   * @param customParser The parser name, class or function
   * @param request Http request
   */
  private async _invokeCustomParser(
    customParser: string | Constructor<BodyParser> | BodyParserFunction,
    request: Request,
  ) {
    if (typeof customParser === 'string') {
      const parser = this.parsers.find(p => p.name === customParser);
      if (parser) {
        debug('Using custom parser %s', customParser);
        return parser.parse(request);
      }
    } else if (typeof customParser === 'function') {
      if (isBodyParserClass(customParser)) {
        debug('Using custom parser class %s', customParser.name);
        const parser = await instantiateClass<BodyParser>(
          customParser as Constructor<BodyParser>,
          this.ctx!,
        );
        return parser.parse(request);
      } else {
        debug('Using custom parser function %s', customParser.name);
        return customParser(request);
      }
    }
    throw new Error('Custom parser not found: ' + customParser);
  }
}

/**
 * Test if a function is a body parser class or plain function
 * @param fn
 */
function isBodyParserClass(
  fn: Constructor<BodyParser> | BodyParserFunction,
): fn is Constructor<BodyParser> {
  return fn.toString().startsWith('class ');
}

/**
 * Sort body parsers so that built-in ones are used after extensions
 * @param parsers
 */
function sortParsers(parsers: BodyParser[]) {
  return parsers.sort((a, b) => {
    const i1 = BUILT_IN_PARSERS.indexOf(a.name);
    const i2 = BUILT_IN_PARSERS.indexOf(b.name);
    return i1 - i2;
  });
}
