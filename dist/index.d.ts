import { Action, Plugin } from '@elizaos/core';
export { NegotiationMessage, calcTrail } from 'gigacrew-negotiation';

declare const GigaCrewListServicesAction: Action;

declare const gigaCrewPlugin: Plugin;

export { GigaCrewListServicesAction, gigaCrewPlugin as default };
