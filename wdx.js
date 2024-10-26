/**
 * Elrest - Node RED - Runtime Node
 * 
 * @copyright 2024 Elrest Automations Systeme GMBH
 */

module.exports = function (RED) {

	"use strict";

	const ws = require("ws");
	const uuid = require("uuid");
	const { Subject, BehaviorSubject } = require("rxjs");

	const WDXSchema = require("@wago/wdx-schema");

	const WS_STATUS_ONLINE_COLOR = 'green'; //@todo Wago green not work as format: #6EC800 , rgb(110, 200, 0)
	const WS_STATUS_OFFLINE_COLOR = 'red';
	const WS_STATUS_ERROR_COLOR = 'red';
	const WS_STATUS_CONNECTING_COLOR = 'blue';

	const WS_STATUS_CODES = {
		CONNECTING: 'CONNECTING',
		OPEN: 'OPEN',
		CLOSING: 'CLOSING',
		CLOSED: 'CLOSED'
	};

	const NODE_STATUS = {
		OPEN: {
			fill: WS_STATUS_ONLINE_COLOR,
			shape: "dot",
			text: "Open"
		},
		ERROR: {
			fill: WS_STATUS_ERROR_COLOR,
			shape: "dot",
			text: "Error"
		},
		CLOSED: {
			fill: WS_STATUS_OFFLINE_COLOR,
			shape: "dot",
			text: "Closed"
		},
		CONNECTING: {
			fill: WS_STATUS_CONNECTING_COLOR,
			shape: "dot",
			text: "Connecting"
		},
		CLOSING: {
			fill: WS_STATUS_CONNECTING_COLOR,
			shape: "dot",
			text: "Closing"
		}
	};

	const WS_RECONNECT_TIMEOUT = 1000;

	function EDesignRuntimeWebSocketClient(config) {
		console.log("EDesignRuntimeWebSocketClient");
		RED.nodes.createNode(this, config);

		this.__ws = undefined;
		this.__wsStatus = new BehaviorSubject(WS_STATUS_CODES.CONNECTING);
		this.__wsIncomingMessages = new Subject();
		this.__closing = false;

		const __connect = async () => {

			this.__ws = new ws(config.url);
			this.__ws.setMaxListeners(0);
			this.__ws.uuid = uuid.v4();

			this.__ws.on('open', () => {
				//console.log("EDesignRuntimeWebSocketClient.opened");

				this.__wsStatus.next(WS_STATUS_CODES.OPEN);
				this.emit(
					'opened',
					{
						count: '',
						id: this.__ws.uuid
					}
				);
			});

			this.__ws.on('close', () => {

				//console.log("EDesignRuntimeWebSocketClient.ws.closed", this.__closing);
				this.__wsStatus.next(WS_STATUS_CODES.CLOSED);

				this.emit('closed', { count: '', id: this.__ws.uuid });

				if (!this.__closing) {
					// Node is closing - do not reconnect ws after its disconnection when node shutdown
					clearTimeout(this.tout);
					//console.log("EDesignRuntimeWebSocketClient.ws.reconnect");
					this.tout = setTimeout(
						() => {
							__connect();
						}, WS_RECONNECT_TIMEOUT
					);
				}
			});

			this.__ws.on('error', (err) => {

				console.error("EDesignRuntimeWebSocketClient.error", err);

				this.emit(
					'erro',
					{
						err: err,
						id: this.__ws.uuid
					}
				);

				if (!this.__closing) {
					clearTimeout(this.tout);

					this.tout = setTimeout(
						() => {
							__connect();
						}, WS_RECONNECT_TIMEOUT
					);
				}
			});

			this.__ws.on(
				'message',
				(data, flags) => {
					//console.debug("EDesignRuntimeWebSocketClient.ws.message", data.toString(), flags);
					this.__wsIncomingMessages.next(JSON.parse(data));
				}
			);
		}

		this.on("close", (done) => {
			//console.log("EDesignRuntimeWebSocketClient.close");

			this.__closing = true;
			this.__wsStatus.next(WS_STATUS_CODES.CLOSING);
			this.__ws.close();
			return done();
		});

		__connect();
	}

	EDesignRuntimeWebSocketClient.prototype.wsStatus = function () {
		return this.__wsStatus;
	}

	EDesignRuntimeWebSocketClient.prototype.wsMessages = function () {
		return this.__wsIncomingMessages;
	}

	EDesignRuntimeWebSocketClient.prototype.wsSend = function (data) {
		//console.log("EDesignRuntimeWebSocketClient.send", data);
		this.__ws.send(JSON.stringify(data));
	}

	RED.nodes.registerType("edesign.runtime.web-socket", EDesignRuntimeWebSocketClient);

	function EDesignRuntimeDataGetSchema(config) {

		//console.log("EDesignRuntimeDataGetSchema", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeDataGetSchema.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Data.GetSchemaRequest(
				msg.path ?? config['path'] ?? "",
				msg.level ?? config['level'] ?? 1
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataGetSchemaResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},

					error: (wsError) => {
						console.error("EDesignRuntimeDataGetSchema.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						msg.payload = wsError;
						this.send([null, msg.payload, null]);
					},

					complete: () => {
						console.debug("EDesignRuntimeDataGetSchema.input.complete");
						msg.payload = 'completed';
						this.send([null, null, msg]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataGetSchema.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.get-schema", EDesignRuntimeDataGetSchema);

	function EDesignRuntimeDataSetSchema(config) {

		//console.log("EDesignRuntimeDataSetSchema", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeDataSetSchema.input", { msg: msg, config: config, });

			const schema = msg.schema ?? config['schema'] ?? undefined;

			if (undefined === schema) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Data.SetSchemaRequest(
				schema,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataSetSchemaResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeDataSetSchema.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataSetSchema.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.set-schema", EDesignRuntimeDataSetSchema);

	function EDesignRuntimeDataGetValue(config) {

		//console.log("EDesignRuntimeDataGetValue", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeDataGetValue.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Data.GetValueRequest(
				msg.path ?? config['path'] ?? "",
				msg.level ?? config['level'] ?? "",
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataGetValueResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeDataGetValue.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataGetValue.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.get-value", EDesignRuntimeDataGetValue);

	function EDesignRuntimeDataSetValue(config) {

		//console.log("EDesignRuntimeDataSetValue", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeDataSetValue.input", { msg: msg, config: config });

			const path = msg.path ?? config['path'] ?? undefined;
			const value = msg.value ?? config['value'] ?? undefined;

			if (undefined === path) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Data.SetValueRequest(
				new WDXSchema.WDX.Schema.Model.Data.DataValue(
					path,
					value,
				)
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataSetValueResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null,]);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeDataSetValue.input.wsMessages.error", wsError);
						this.send([null, wsError]);
						subscription.unsubscribe();
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataSetValue.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.set-value", EDesignRuntimeDataSetValue);

	function EDesignRuntimeDataMonitorValue(config) {

		console.debug('EDesignRuntimeDataMonitorValue', config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeDataMonitorValue.input.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {
					const path = msg.path ?? config['path'] ?? "";

					const request = new WDXSchema.WDX.Schema.Message.Data.RegisterValueRequest(
						path
					);

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataRegisterValueResponse
									&& wsMessage.uuid === request.uuid) {

									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg]);
									} else {
										msg.payload = wsMessage.body;

										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);

										this.send([msg, null, null,]);
									}
								}
								else if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataUpdate
									&& wsMessage.body.path === path) {
									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg]);
									} else {
										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);
										msg.payload = wsMessage.body;
										this.send([msg, null, null]);
									}
								}
							},
							error: (subscribtionError) => {
								console.error("EDesignRuntimeDataMonitorValue.input.subscription.error", subscribtionError);
								msg.payload = subscribtionError;
								this.send([null, msg]);
							},
							complete: () => {
								console.debug("EDesignRuntimeDataMonitorValue.input.subscription.complete",);
								this.status(NODE_STATUS.OPEN);
								msg.payload = "complete";
								this.send([null, null, msg]);
							}
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeDataMonitorValue.input.unsubscribe');
				this.subscription.unsubscribe();
				this.status(NODE_STATUS.OPEN);
				msg.payload = "complete";
				this.send([null, null, msg]);
			}
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataRegister.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.monitor-value", EDesignRuntimeDataMonitorValue);

	function EDesignRuntimeDataUnregister(config) {

		//console.log("EDesignRuntimeDataUnregister", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeDataUnregister.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Data.UnregisterRequest(
				msg.path ?? config['path'] ?? ""
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataUnregisterResponse
							&& wsMessage.uuid === request.uuid) {
							if (undefined !== wsMessage.error) {
								this.send([null, wsMessage.error]);
							} else {
								this.send(wsMessage);
								subscription.unsubscribe();
							}
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeDataUnregister.input.wsMessages.error", wsError);
						subscription.unsubscribe();
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataUnregister.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.unregister", EDesignRuntimeDataUnregister);

	function EDesignRuntimeDataMonitorSchema(config) {
		RED.nodes.createNode(this, config);
		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeDataMonitorSchema.input", msg, config);


			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeDataMonitorSchema.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {

					const request = new WDXSchema.WDX.Schema.Message.Data.RegisterSchemaChangesRequest();

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataSchemaChanges) {
									if (undefined !== wsMessage.error) {
										this.send([null, wsMessage.error]);
									} else {
										msg.payload = wsMessage.body;
										this.send([msg, null, null]);
									}
								}
							},

							error: (wsError) => {
								console.error("EDesignRuntimeDataMonitorSchema.input.wsMessages.error", wsError);
								this.send([null, wsError]);
							},

							complete: () => {
								console.error("EDesignRuntimeDataMonitorSchema.input.wsMessages.complete", wsError);
								this.send([null, null, msg]);
							}
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeDataMonitorSchema.unsubscribe');
				this.subscription.unsubscribe();
			}
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataGetValue.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.monitor-schema", EDesignRuntimeDataMonitorSchema);

	function EDesignRuntimeDataUnsubscribeSchema(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeDataGetValue.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Data.UnregisterSchemaChangesRequest();

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.DataUnregisterSchemaChangesResponse && request.uuid === wsMessage.uuid) {
							if (undefined !== wsMessage.error) {
								this.send([null, wsMessage.error]);
							} else {
								this.send(wsMessage);
							}
							subscription.unsubscribe();
						}

					},
					error: (wsError) => {
						console.error("EDesignRuntimeDataUnsubscribeSchema.input.wsMessages.error", wsError);
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataGetValue.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.data.unsubscribe-schema", EDesignRuntimeDataUnsubscribeSchema);

	/**
	 * Instance
	 */
	function EDesignRuntimeInstanceList(config) {

		//console.log("EDesignRuntimeInstanceList", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			//console.log("EDesignRuntimeInstanceList.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Instance.ListRequest(
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceListResponse
							&& wsMessage.uuid === request.uuid) {
							subscription.unsubscribe();

							if (undefined !== wsMessage.error) {
								this.send([null, wsMessage.error]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeDataGetSchema.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.list", EDesignRuntimeInstanceList);

	function EDesignRuntimeInstanceSave(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instance = msg.instance ?? config['instance'] ?? undefined;
			if (undefined === instance) {
				return;
			}

			console.log("EDesignRuntimeInstanceSave.msg", instance);

			const request = new WDXSchema.WDX.Schema.Message.Instance.SaveRequest(
				instance,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceSaveResponse
							&& wsMessage.uuid === request.uuid) {
							subscription.unsubscribe();

							console.log("EDesignRuntimeInstanceSave.wsMessage", wsMessage);
							if (undefined !== wsMessage.error) {
								this.send([null, wsMessage.error]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceSave.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceSave.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.save", EDesignRuntimeInstanceSave,);

	function EDesignRuntimeInstanceDetail(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instanceUUID = msg.instanceUUID ?? config['instanceUUID'] ?? undefined;

			const request = new WDXSchema.WDX.Schema.Message.Instance.DetailRequest(
				instanceUUID,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceDetailResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceDetail.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceDetail.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.detail", EDesignRuntimeInstanceDetail,);

	function EDesignRuntimeInstanceStart(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instanceUUID = msg.instanceUUID ?? config['instanceUUID'] ?? undefined;


			const request = new WDXSchema.WDX.Schema.Message.Instance.StartRequest(
				instanceUUID,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceStartResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}

							subscription.unsubscribe();

						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceDetail.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceDetail.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.start", EDesignRuntimeInstanceStart);

	function EDesignRuntimeInstanceStop(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instanceUUID = msg.instanceUUID ?? config['instanceUUID'] ?? undefined;

			const request = new WDXSchema.WDX.Schema.Message.Instance.StopRequest(
				instanceUUID,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceStopResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceStop.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceStop.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.stop", EDesignRuntimeInstanceStop);

	function EDesignRuntimeInstanceRestart(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instanceUUID = msg.instanceUUID ?? config['instanceUUID'] ?? undefined;
			const request = new WDXSchema.WDX.Schema.Message.Instance.RestartRequest(
				instanceUUID,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceRestartResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceRestart.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceRestart.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.restart", EDesignRuntimeInstanceRestart);

	function EDesignRuntimeInstanceDelete(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const instanceUUID = msg.instanceUUID ?? config['instanceUUID'] ?? undefined;
			const request = new WDXSchema.WDX.Schema.Message.Instance.DeleteRequest(
				instanceUUID,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceDeleteResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceRestart.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceRestart.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.delete", EDesignRuntimeInstanceDelete);

	function EDesignRuntimeInstanceSubscribeMonitor(config) {

		console.debug('EDesignRuntimeInstanceSubscribeMonitor', config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.debug('EDesignRuntimeInstanceSubscribeMonitor.input', msg);

			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeInstanceSubscribeMonitor.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {

					const request = new WDXSchema.WDX.Schema.Message.Runtime.MonitorSubscribeRequest();

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if ((wsMessage.type === WDXSchema.WDX.Schema.Message.Type.RuntimeMonitorSubscribeResponse
									&& wsMessage.uuid === request.uuid)
									|| wsMessage.type === WDXSchema.WDX.Schema.Message.Type.RuntimeMonitor) {

									console.debug('EDesignRuntimeInstanceSubscribeMonitor.subscription.next', wsMessage);

									msg.topic = wsMessage.topic;

									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg]);
									} else {
										msg.payload = wsMessage.body;

										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);

										this.send([msg, null, null,]);
									}
								}
							},

							error: (subscribtionError) => {
								console.error("EDesignRuntimeInstanceSubscribeMonitor.input.subscribtion.error", subscribtionError);
								msg.payload = subscribtionError;
								this.send([null, msg]);
							},

							complete: () => {
								console.debug("EDesignRuntimeInstanceSubscribeMonitor.input.subscribtion.complete",);
								this.status(NODE_STATUS.OPEN);
								msg.payload = "complete";
								this.send([null, null, msg]);
							}
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeInstanceSubscribeMonitor.input.unsubscribe');
				this.subscription.unsubscribe();
				this.status(NODE_STATUS.OPEN);
				msg.payload = "complete";
				this.send([null, null, msg]);
			}

		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceSubscribeMonitor.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.monitor", EDesignRuntimeInstanceSubscribeMonitor,);

	function EDesignRuntimeInstanceUnsubscribeMonitor(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Runtime.MonitorUnsubscribeRequest();
			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.RuntimeMonitorUnsubscribeResponse
							&& wsMessage.uuid === request.uuid) {
							if (undefined !== wsMessage.error) {
								this.send([null, wsMessage.error]);
							} else {
								this.send(wsMessage);
							}
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeInstanceSubscribeMonitor.input.wsMessages.error", wsError);
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceSubscribeMonitor.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.unsubscribe-monitor", EDesignRuntimeInstanceUnsubscribeMonitor,);

	function EDesignRuntimeInstanceSubscribeLog(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {


			console.debug('EDesignRuntimeInstanceSubscribeLog.input', msg);

			const instanceUUID = msg.uuid ?? config['uuid'] ?? undefined;
			if (undefined === instanceUUID) {
				return;
			}

			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeInstanceSubscribeLog.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {

					const request = new WDXSchema.WDX.Schema.Message.Instance.LogSubscribeRequestMessage(instanceUUID);

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if ((wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceLogSubscribeResponse
									&& wsMessage.uuid === request.uuid) || wsMessage.type === WDXSchema.WDX.Schema.Message.Type.InstanceLog) {

									console.debug('EDesignRuntimeInstanceSubscribeLog.subscription.next', wsMessage);
									msg.topic = wsMessage.topic;

									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg, null]);
									} else {
										msg.payload = wsMessage.body;

										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);

										this.send([msg, null, null,]);
									}
								}
							},

							error: (subscribtionError) => {
								console.error("EDesignRuntimeInstanceSubscribeLog.input.wsMessages.error", subscribtionError);
								msg.payload = subscribtionError;

								this.send([null, msg]);
							},

							complete: () => {
								console.debug("EDesignRuntimeInstanceSubscribeLog.input.subscribtion.complete",);
								this.status(NODE_STATUS.OPEN);
								msg.payload = "complete";
								this.send([null, null, msg]);
							}
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeInstanceSubscribeLog.unsubscribe');
				this.subscription.unsubscribe();
				this.status(NODE_STATUS.OPEN);
				msg.payload = "complete";
				this.send([null, null, msg]);;
			}
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeInstanceRestart.close");
			this.status(NODE_STATUS.OPEN);
		});
	}
	RED.nodes.registerType("edesign.runtime.instance.monitor-log", EDesignRuntimeInstanceSubscribeLog,);

	function EDesignRuntimeInstanceUnsubscribeLog(config) {
	}
	RED.nodes.registerType("edesign.runtime.instance.unsubscribe-log", EDesignRuntimeInstanceUnsubscribeLog,);

	/**
	 * Alarms
	 */

	//edesign.runtime.alarm.list
	function EDesignRuntimeAlarmList(config) {

		console.log("EDesignRuntimeAlarmList", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeAlarmList.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListRequest(
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.list", EDesignRuntimeAlarmList,);

	//edesign.runtime.alarm.list-active
	function EDesignRuntimeAlarmListActive(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeAlarmList.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListRequest(true);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.list-active", EDesignRuntimeAlarmListActive,);

	//edesign.runtime.alarm.list-history
	function EDesignRuntimeAlarmListHistory(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListHistoryRequest(
				msg.alarmId ?? config['alarmId'] ?? "",
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListHistoryResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});

	}
	RED.nodes.registerType("edesign.runtime.alarm.list-history", EDesignRuntimeAlarmListHistory,);

	//edesign.runtime.alarm.confirm
	function EDesignRuntimeAlarmConfirm(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ConfirmRequest(
				msg.alarmId ?? config['alarmId'] ?? undefined,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingConfirmResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmConfirm.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.confirm", EDesignRuntimeAlarmConfirm,);

	//edesign.runtime.alarm.confirm-all
	function EDesignRuntimeAlarmConfirmAll(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ConfirmRequest();

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingConfirmResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmConfirmAll.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.confirm-all", EDesignRuntimeAlarmConfirmAll,);

	//edesign.runtime.alarm.changes
	function EDesignRuntimeAlarmChanges(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeAlarmChanges.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {

					const request = new WDXSchema.WDX.Schema.Message.Alarm.SubscribeRequest();

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if ((wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingSubscribeResponse
									&& wsMessage.uuid === request.uuid) || wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingUpdate) {

									console.debug('EDesignRuntimeAlarmChanges.subscription.next', wsMessage);

									msg.topic = wsMessage.topic;

									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg]);
									} else {
										msg.payload = wsMessage.body;

										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);

										this.send([msg, null, null,]);
									}
								}
							},
							error: (subscribtionError) => {
								console.error("EDesignRuntimeAlarmChanges.input.wsMessages.error", subscribtionError);
								msg.payload = subscribtionError;
								this.send([null, msg]);
							},
							complete: () => {
								this.status(NODE_STATUS.OPEN);
								msg.payload = "complete";
								this.send([null, null, msg]);
							},
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeAlarmChanges.unsubscribe');

				this.subscription.unsubscribe();
				this.status(NODE_STATUS.OPEN);
				msg.payload = "complete";
				this.send([null, null, msg]);
			}
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.changes", EDesignRuntimeAlarmChanges,);

	//edesign.runtime.alarm.detail
	function EDesignRuntimeAlarmDetail(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarmId = msg.alarmId ?? config['alarmId'] ?? undefined;
			if (undefined === alarmId) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.DetailRequest(
				alarmId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingDetailResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmDetail.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.detail", EDesignRuntimeAlarmDetail,);

	function EDesignRuntimeAlarmSave(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarm = msg.payload ?? config['alarm'] ?? undefined;

			console.error("EDesignRuntimeAlarmSave.input", { msg: msg, config: config });

			if (undefined === alarm) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.SetRequest(
				alarm,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingSetResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmSave.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmSave.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.save", EDesignRuntimeAlarmSave,);

	//edesign.runtime.alarm.delete
	function EDesignRuntimeAlarmDelete(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarmId = msg.alarmId ?? config['alarmId'] ?? undefined;
			if (undefined === alarmId) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.DeleteRequest(
				alarmId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingDeleteResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmDelete.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.delete", EDesignRuntimeAlarmDelete,);

	/**
	 * Trends
	 */

	//edesign.runtime.trend.list
	function EDesignRuntimeTrendList(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Trend.ListRequest();

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingListResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.list", EDesignRuntimeTrendList,);

	//edesign.runtime.trend.detail
	function EDesignRuntimeTrendDetail(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trendId = msg.trendId ?? config['trendId'] ?? undefined;
			if (undefined === trendId) {
				return;
			}
			const request = new WDXSchema.WDX.Schema.Message.Trend.DetailRequest(
				trendId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingDetailResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendDetail.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendDetail.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.detail", EDesignRuntimeTrendDetail,);

	//edesign.runtime.trend.delete
	function EDesignRuntimeTrendDelete(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trendId = msg.trendId ?? config['trendId'] ?? undefined;
			if (undefined === trendId) {
				return;
			}
			const request = new WDXSchema.WDX.Schema.Message.Trend.DeleteRequest(
				trendId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingDeleteResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null, null]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.delete", EDesignRuntimeTrendDelete,);

	//edesign.runtime.trend.save
	function EDesignRuntimeTrendSave(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trend = msg.payload ?? config['trend'] ?? undefined;
			if (undefined === trend) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Trend.SetRequest(
				trend,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingSaveResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null,]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendSave.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.save", EDesignRuntimeTrendSave,);


	//edesign.runtime.trend.export-csv
	function EDesignRuntimeTrendExportCSV(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trend = msg.payload ?? config['trend'] ?? undefined;
			if (undefined === trend) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Trend.TrendExportRequest(
				trend,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingExportResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null,]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendExportCSV.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.export-csv", EDesignRuntimeTrendExportCSV,);

	//edesign.runtime.trend.export-image
	function EDesignRuntimeTrendExportImage(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trend = msg.payload ?? config['trend'] ?? undefined;
			if (undefined === trend) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Trend.TrendExportRequest(
				trend,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingExportResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null,]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendExportCSV.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.export-image", EDesignRuntimeTrendExportImage,);

	//edesign.runtime.trend.export-sqlite
	function EDesignRuntimeTrendExportSQLite(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trend = msg.payload ?? config['trend'] ?? undefined;

			if (undefined === trend) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Trend.TrendExportRequest(
				trend,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingExportResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null,]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendExportSQLite.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.export-sqlite", EDesignRuntimeTrendExportSQLite,);


	//edesign.runtime.trend.monitor
	function EDesignRuntimeTrendExportMonitor(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const trendUuid = msg.payload ?? config['trendUuid'] ?? undefined;

			if (undefined === trendUuid) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Trend.Trend.SubscribeRequest(
				trendUuid,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if ((wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingSubscribeResponse
							&& wsMessage.uuid === request.uuid)
						|| wsMessage.type === WDXSchema.WDX.Schema.Message.Type.TrendingUpdate) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send([msg, null,]);
							}
							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeTrendExportMonitor.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeTrendList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.trend.monitor", EDesignRuntimeTrendExportMonitor,);
}