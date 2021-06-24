const vscode = require('vscode')
const { spawn } = require('child_process')
const os = require("os")

/**
 * @returns {Promise<void>}
 * @throws {Error | null}
 */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string} */content) => {
    return new Promise((resolve, reject) => {
        // 1. Authenticate with `sudo bash -p 'password:'`
        // 2. Call `echo file contents:` to inform the parent process that the authentication was successful
        // 3. Write the file contents with `tee <&0 "$filename"`
        const p = spawn(`sudo -S -p 'password:' --preserve-env=filename bash -c 'echo "file contents:" >&2; tee <&0 "$filename" > /dev/null'`, { shell: "/bin/bash", env: { filename } })
        const cancel = (/** @type {Error | null} */err = null) => {
            if (!p.killed) { p.kill() }
            reject(err)
        }

        // Set a timeout because the script may wait forever for stdin on error.
        /** @type {NodeJS.Timeout | null} */
        let timer = null
        const startTimer = () => {
            timer = setTimeout(() => {
                if (p.exitCode === null) {
                    cancel(new Error(`Timeout: ${stderr}`))
                }
            }, 100000)
        }
        const stopTimer = () => {
            if (timer !== null) { clearTimeout(timer) }
            timer = null
        }
        startTimer()

        // Handle stderr
        let stderr = ''
        p.stderr?.on("data", (/** @type {Buffer | string} */chunk) => {
            const lines = chunk.toString().split("\n").map((line) => line.trim())
            if (lines.includes("password:")) {
                // password prompt
                stopTimer()
                vscode.window.showInputBox({ password: true, title: "Save as Root", placeHolder: `password for ${os.userInfo().username}`, prompt: stderr !== "" ? `\n${stderr}` : "" }).then((password) => {
                    if (password === undefined) { return cancel() }
                    startTimer()
                    p.stdin?.write(`${password}\n`)
                }, cancel)
                stderr = ""
            } else if (lines.includes("file contents:")) {
                // authentication succeeded
                p.stdin?.write(content)
                p.stdin?.end()
            } else {
                // error message
                stderr += chunk.toString()
            }
        })

        // Exit
        p.on("exit", (code) => {
            if (code === 0) {
                return resolve()
            } else {
                reject(new Error(`exit code ${code}: ${stderr}`))
            }
        })
    })
}

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    context.subscriptions.push(vscode.commands.registerCommand('save-as-root.saveFile', async () => {
        // Check the status of the editor
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }

        try {
            if (editor.document.isUntitled) {
                // Show the save dialog
                const input = await vscode.window.showSaveDialog({})
                if (input === undefined) {
                    return
                }
                const filename = input.fsPath

                // Create a file and write the editor content to it
                await sudoWriteFile(filename, editor.document.getText())

                const column = editor.viewColumn

                // Clear the content of the editor so that the save dialog won't be displayed when executing `workbench.action.closeActiveEditor`.
                await editor.edit((editBuilder) => editBuilder.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)))

                // Close the editor for the untitled file
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor')

                // Open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename), column)
            } else {
                // Write the editor content to the file
                await sudoWriteFile(editor.document.fileName, editor.document.getText())

                // Reload the file contents from the file system
                await vscode.commands.executeCommand("workbench.action.files.revert")
            }
        } catch (err) {
            // Handle errors
            if (err === null) {
                console.log("canceled")
                return
            }
            console.error(err)
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
    }))
}

exports.deactivate = () => { }
