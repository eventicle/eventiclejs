import {AggregateRoot, EventicleEvent} from "../../../../../../api/eventiclejs";

// tag::class[]
export class SystemUser extends AggregateRoot {

  private _name: string  // <1>

  constructor() {
    super("SystemUser");   // <2>

    this.reducers = []
    this.reducers["user.created"] = (event: EventicleEvent) => {   // <3>
      this.id = event.domainId;          // <4>
      this._name = event.data.username;  // <5>
    }
  }

  set name(name: string) {

    this.raiseEvent({    // <6>
      type: "user.created",
      data: {
        name
      }
    })
  }
}
// tag::class[]
